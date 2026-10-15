/*
Studio Host for OBS
Copyright (C) 2026 Callstrom Code Works

This program is free software; you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation; either version 2 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>
*/

// Studio Host source types. Each one wraps a private OBS Browser Source that loads
// a page from the local Studio Host server, so users never deal with URLs or ports:
//
//   Studio Host Program       renders the shared studio hub (stage, branding, banners)
//   Studio Host Guest         one guest slot (camera or screen), optional audio
//   Studio Host Guest Screen Share  the featured guest screen share, full frame
//   Studio Host Audio         program audio; placed on a global mixer channel by the plugin

#include "studio-sources.hpp"

#include <obs-module.h>
#include <plugin-support.h>
#include <util/dstr.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <iterator>
#include <mutex>
#include <set>
#include <string>
#include <vector>

namespace studiohost {
namespace {

enum class Kind { Program, Guest, Screen };

struct Wrapper {
	obs_source_t *self = nullptr;
	Kind kind = Kind::Program;
	obs_source_t *child = nullptr; // guest/screen: owned private browser; program: unused
	bool audio_hooked = false;
	// Guest options
	long long slot = 1;
	std::string content = "camera";
	std::string fit = "cover";
	bool names = false;
	bool always = false;
	bool audio = false;
	// Program: the OBS source currently drawn as content beneath the studio picture.
	std::mutex content_mutex;              // guards attached
	obs_weak_source_t *attached = nullptr; // registered as an active child of self
	float rect[4] = {0, 0, 0, 0};          // animated position (0..1 of the frame)
	float alpha = 0;                       // > 0 while drawn (lingers while the hole fades out)
	bool rect_valid = false;
};

std::mutex state_mutex; // guards base_url, program_browser, wrappers
std::string base_url;   // empty until the server is ready
obs_source_t *program_browser = nullptr;
std::set<Wrapper *> wrappers;

// The OBS source shown as content in Program sources, and where (set from the server).
std::mutex content_mutex;
obs_weak_source_t *content_weak = nullptr;
float content_target[4] = {0, 0, 0, 0};

std::mutex audio_mutex; // guards audio_sinks (Studio Host Audio sources)
std::set<obs_source_t *> audio_sinks;

void canvas_size(uint32_t &w, uint32_t &h)
{
	obs_video_info ovi = {};
	if (obs_get_video_info(&ovi) && ovi.base_width && ovi.base_height) {
		w = ovi.base_width;
		h = ovi.base_height;
	} else {
		w = 1920;
		h = 1080;
	}
}

int canvas_fps()
{
	obs_video_info ovi = {};
	if (!obs_get_video_info(&ovi) || !ovi.fps_den)
		return 30;
	int fps = (int)((ovi.fps_num + ovi.fps_den / 2) / ovi.fps_den);
	return fps < 1 ? 1 : (fps > 60 ? 60 : fps);
}

obs_data_t *browser_settings(const std::string &url, bool reroute_audio)
{
	uint32_t w, h;
	canvas_size(w, h);
	obs_data_t *s = obs_data_create();
	obs_data_set_bool(s, "is_local_file", false);
	obs_data_set_string(s, "url", url.c_str());
	obs_data_set_int(s, "width", w);
	obs_data_set_int(s, "height", h);
	// A custom frame rate makes Chromium drive its own frames. With the default (OBS-driven
	// frames), a browser only advances when OBS draws it, so the studio hub and guest pages
	// would freeze — and their WebRTC connections stall — whenever they are not on screen.
	obs_data_set_bool(s, "fps_custom", true);
	obs_data_set_int(s, "fps", canvas_fps());
	obs_data_set_bool(s, "reroute_audio", reroute_audio);
	obs_data_set_bool(s, "shutdown", false);
	obs_data_set_bool(s, "restart_when_active", false);
	return s;
}

std::string current_base()
{
	std::lock_guard<std::mutex> lock(state_mutex);
	return base_url;
}

// Re-emits audio captured from a browser as the audio of `target`.
void forward_audio(obs_source_t *target, const struct audio_data *audio)
{
	const struct audio_output_info *info = audio_output_get_info(obs_get_audio());
	if (!info)
		return;
	obs_source_audio out = {};
	for (size_t i = 0; i < MAX_AV_PLANES; i++)
		out.data[i] = audio->data[i];
	out.frames = audio->frames;
	out.timestamp = audio->timestamp;
	out.speakers = info->speakers;
	out.samples_per_sec = info->samples_per_sec;
	out.format = AUDIO_FORMAT_FLOAT_PLANAR;
	obs_source_output_audio(target, &out);
}

void program_audio_cb(void *, obs_source_t *, const struct audio_data *audio, bool muted)
{
	if (muted)
		return;
	std::lock_guard<std::mutex> lock(audio_mutex);
	for (obs_source_t *sink : audio_sinks)
		forward_audio(sink, audio);
}

void guest_audio_cb(void *param, obs_source_t *, const struct audio_data *audio, bool muted)
{
	auto *w = static_cast<Wrapper *>(param);
	if (!muted)
		forward_audio(w->self, audio);
}

// Returns a new reference to the browser this wrapper draws (caller releases), or nullptr.
obs_source_t *render_target(Wrapper *w)
{
	if (w->kind != Kind::Program)
		return obs_source_get_ref(w->child);
	std::lock_guard<std::mutex> lock(state_mutex);
	return program_browser ? obs_source_get_ref(program_browser) : nullptr;
}

std::string guest_url(const Wrapper *w, const std::string &base)
{
	std::string url = base + "/output/slot.html?slot=" + std::to_string(w->slot);
	if (w->content == "screen")
		url += "&source=screen";
	if (w->fit == "contain")
		url += "&fit=contain";
	if (w->names)
		url += "&names=1";
	if (w->always)
		url += "&always=1";
	if (w->audio)
		url += "&audio=1";
	return url;
}

std::string child_url(const Wrapper *w, const std::string &base)
{
	// Until the server is up, park the page on a blank document; it is pointed at the
	// server when it becomes ready (loading earlier would leave a browser error page).
	if (base.empty())
		return "about:blank";
	if (w->kind == Kind::Screen)
		return base + (w->fit == "cover" ? "/output/feature.html?fit=cover" : "/output/feature.html");
	return guest_url(w, base);
}

void load_options(Wrapper *w, obs_data_t *settings)
{
	if (w->kind == Kind::Guest) {
		w->slot = obs_data_get_int(settings, "slot");
		if (w->slot < 1)
			w->slot = 1;
		w->content = obs_data_get_string(settings, "content");
		w->names = obs_data_get_bool(settings, "names");
		w->always = obs_data_get_bool(settings, "always");
		w->audio = obs_data_get_bool(settings, "audio");
	}
	if (w->kind != Kind::Program)
		w->fit = obs_data_get_string(settings, "fit");
}

void set_guest_audio(Wrapper *w, bool on)
{
	if (on == w->audio_hooked || !w->child)
		return;
	if (on)
		obs_source_add_audio_capture_callback(w->child, guest_audio_cb, w);
	else
		obs_source_remove_audio_capture_callback(w->child, guest_audio_cb, w);
	w->audio_hooked = on;
}

// ---- callbacks shared by the three video wrappers --------------------------

void *wrapper_create(Kind kind, obs_data_t *settings, obs_source_t *source)
{
	auto *w = new Wrapper();
	w->self = source;
	w->kind = kind;
	load_options(w, settings);
	if (kind != Kind::Program) {
		std::string name = std::string("studiohost-child-") + obs_source_get_name(source);
		obs_data_t *bs = browser_settings(child_url(w, current_base()), kind == Kind::Guest && w->audio);
		w->child = obs_source_create_private("browser_source", name.c_str(), bs);
		obs_data_release(bs);
		if (!w->child) {
			obs_log(LOG_ERROR, "could not create a browser for '%s' (is the OBS Browser plugin installed?)",
				obs_source_get_name(source));
		} else {
			// Keep the page "visible" even when this source is not in the live scene, so the
			// guest's connection stays up and cutting to this source is instant (Chromium
			// throttles hidden pages, which stalls their WebRTC signaling).
			obs_source_inc_showing(w->child);
			if (kind == Kind::Guest)
				set_guest_audio(w, w->audio);
		}
	}
	std::lock_guard<std::mutex> lock(state_mutex);
	wrappers.insert(w);
	return w;
}

void wrapper_destroy(void *data)
{
	auto *w = static_cast<Wrapper *>(data);
	{
		std::lock_guard<std::mutex> lock(state_mutex);
		wrappers.erase(w);
	}
	if (w->child) {
		set_guest_audio(w, false);
		obs_source_dec_showing(w->child);
		obs_source_release(w->child);
	}
	if (w->attached) {
		obs_source_t *old = obs_weak_source_get_source(w->attached);
		if (old) {
			obs_source_remove_active_child(w->self, old);
			obs_source_release(old);
		}
		obs_weak_source_release(w->attached);
	}
	delete w;
}

void wrapper_update(void *data, obs_data_t *settings)
{
	auto *w = static_cast<Wrapper *>(data);
	if (w->kind == Kind::Program)
		return;
	load_options(w, settings);
	if (!w->child)
		return;
	obs_data_t *bs = browser_settings(child_url(w, current_base()), w->kind == Kind::Guest && w->audio);
	obs_source_update(w->child, bs);
	obs_data_release(bs);
	set_guest_audio(w, w->kind == Kind::Guest && w->audio);
}

uint32_t wrapper_width(void *data);
uint32_t wrapper_height(void *data);

// Draws the content source (Program only) scaled to fit its rectangle. The studio picture is
// drawn on top of it; the browser leaves that rectangle transparent.
void render_content(Wrapper *w)
{
	obs_source_t *content = nullptr;
	{
		std::lock_guard<std::mutex> lock(w->content_mutex);
		if (w->attached && w->alpha > 0.0f && w->rect_valid)
			content = obs_weak_source_get_source(w->attached);
	}
	if (!content)
		return;
	uint32_t sw = obs_source_get_width(content), sh = obs_source_get_height(content);
	float W = (float)wrapper_width(w), H = (float)wrapper_height(w);
	if (sw && sh && W > 0 && H > 0) {
		float rx = w->rect[0] * W, ry = w->rect[1] * H, rw = w->rect[2] * W, rh = w->rect[3] * H;
		float scale = std::min(rw / (float)sw, rh / (float)sh);
		float dx = rx + (rw - (float)sw * scale) / 2.0f, dy = ry + (rh - (float)sh * scale) / 2.0f;
		gs_matrix_push();
		gs_matrix_translate3f(dx, dy, 0.0f);
		gs_matrix_scale3f(scale, scale, 1.0f);
		obs_source_video_render(content);
		gs_matrix_pop();
	}
	obs_source_release(content);
}

void wrapper_render(void *data, gs_effect_t *)
{
	auto *w = static_cast<Wrapper *>(data);
	if (w->kind == Kind::Program)
		render_content(w);
	obs_source_t *target = render_target(w);
	if (target) {
		obs_source_video_render(target);
		obs_source_release(target);
	}
}

// Program: follow the chosen content source (attach it as an active child so it is shown
// and activated with this source) and animate its rectangle like the browser animates tiles.
void program_tick(void *data, float seconds)
{
	auto *w = static_cast<Wrapper *>(data);
	obs_source_t *want = nullptr;
	float target[4];
	{
		std::lock_guard<std::mutex> lock(content_mutex);
		want = content_weak ? obs_weak_source_get_source(content_weak) : nullptr;
		std::copy(std::begin(content_target), std::end(content_target), target);
	}

	obs_source_t *current = nullptr;
	{
		std::lock_guard<std::mutex> lock(w->content_mutex);
		current = w->attached ? obs_weak_source_get_source(w->attached) : nullptr;
	}

	if (want && want != current) {
		// add_active_child refuses sources that contain this one (e.g. a scene holding the
		// Program source), which would otherwise draw itself recursively.
		if (obs_source_add_active_child(w->self, want)) {
			if (current)
				obs_source_remove_active_child(w->self, current);
			std::lock_guard<std::mutex> lock(w->content_mutex);
			obs_weak_source_release(w->attached);
			w->attached = obs_source_get_weak_source(want);
			if (!w->rect_valid || w->alpha <= 0.0f) {
				std::copy(target, target + 4, w->rect);
				w->rect_valid = true;
			}
		}
	}

	bool showing = want && w->attached && want == current;
	if (!showing && want) {
		// Just attached above (or refused): check again.
		std::lock_guard<std::mutex> lock(w->content_mutex);
		obs_source_t *now = w->attached ? obs_weak_source_get_source(w->attached) : nullptr;
		showing = now == want;
		obs_source_release(now);
	}

	const float k = 1.0f - std::pow(0.0005f, std::min(seconds, 0.1f)); // same easing as the browser
	{
		std::lock_guard<std::mutex> lock(w->content_mutex);
		if (showing)
			for (int i = 0; i < 4; i++)
				w->rect[i] += (target[i] - w->rect[i]) * k;
		w->alpha += ((showing ? 1.0f : 0.0f) - w->alpha) * k;
		if (!showing && w->alpha < 0.02f)
			w->alpha = 0.0f;
	}

	// Detach once the fade-out is done.
	if (!showing && current && w->alpha <= 0.0f) {
		obs_source_remove_active_child(w->self, current);
		std::lock_guard<std::mutex> lock(w->content_mutex);
		obs_weak_source_release(w->attached);
		w->attached = nullptr;
		w->rect_valid = false;
	}
	obs_source_release(current);
	obs_source_release(want);
}

void program_enum_active(void *data, obs_source_enum_proc_t cb, void *param)
{
	auto *w = static_cast<Wrapper *>(data);
	obs_source_t *child = nullptr;
	{
		std::lock_guard<std::mutex> lock(w->content_mutex);
		child = w->attached ? obs_weak_source_get_source(w->attached) : nullptr;
	}
	if (child) {
		cb(w->self, child, param);
		obs_source_release(child);
	}
}

uint32_t wrapper_width(void *data)
{
	obs_source_t *target = render_target(static_cast<Wrapper *>(data));
	uint32_t w = target ? obs_source_get_width(target) : 0;
	obs_source_release(target);
	if (!w) {
		uint32_t h;
		canvas_size(w, h);
	}
	return w;
}

uint32_t wrapper_height(void *data)
{
	obs_source_t *target = render_target(static_cast<Wrapper *>(data));
	uint32_t h = target ? obs_source_get_height(target) : 0;
	obs_source_release(target);
	if (!h) {
		uint32_t w;
		canvas_size(w, h);
	}
	return h;
}

// Interaction (right-click → Interact) is passed through to the page.
void wrapper_mouse_click(void *data, const struct obs_mouse_event *event, int32_t type, bool mouse_up,
			 uint32_t click_count)
{
	obs_source_t *t = render_target(static_cast<Wrapper *>(data));
	if (t) {
		obs_source_send_mouse_click(t, event, type, mouse_up, click_count);
		obs_source_release(t);
	}
}
void wrapper_mouse_move(void *data, const struct obs_mouse_event *event, bool mouse_leave)
{
	obs_source_t *t = render_target(static_cast<Wrapper *>(data));
	if (t) {
		obs_source_send_mouse_move(t, event, mouse_leave);
		obs_source_release(t);
	}
}
void wrapper_mouse_wheel(void *data, const struct obs_mouse_event *event, int x_delta, int y_delta)
{
	obs_source_t *t = render_target(static_cast<Wrapper *>(data));
	if (t) {
		obs_source_send_mouse_wheel(t, event, x_delta, y_delta);
		obs_source_release(t);
	}
}
void wrapper_focus(void *data, bool focus)
{
	obs_source_t *t = render_target(static_cast<Wrapper *>(data));
	if (t) {
		obs_source_send_focus(t, focus);
		obs_source_release(t);
	}
}
void wrapper_key_click(void *data, const struct obs_key_event *event, bool key_up)
{
	obs_source_t *t = render_target(static_cast<Wrapper *>(data));
	if (t) {
		obs_source_send_key_click(t, event, key_up);
		obs_source_release(t);
	}
}

// ---- Program --------------------------------------------------------------------

// Program: pass on the content source's audio, so an OBS source shown as content is heard
// as well as seen (OBS mixes a child's audio only through a composite parent).
bool program_audio_render(void *data, uint64_t *ts_out, struct obs_source_audio_mix *audio_output, uint32_t mixers,
			  size_t channels, size_t)
{
	auto *w = static_cast<Wrapper *>(data);
	obs_source_t *child = nullptr;
	{
		std::lock_guard<std::mutex> lock(w->content_mutex);
		child = w->attached ? obs_weak_source_get_source(w->attached) : nullptr;
	}
	if (!child)
		return false;
	bool have = false;
	uint64_t ts = obs_source_audio_pending(child) ? 0 : obs_source_get_audio_timestamp(child);
	if (ts) {
		obs_source_audio_mix child_audio = {};
		obs_source_get_audio_mix(child, &child_audio);
		for (size_t mix = 0; mix < MAX_AUDIO_MIXES; mix++) {
			if ((mixers & (1u << mix)) == 0)
				continue;
			for (size_t ch = 0; ch < channels; ch++)
				memcpy(audio_output->output[mix].data[ch], child_audio.output[mix].data[ch],
				       AUDIO_OUTPUT_FRAMES * sizeof(float));
		}
		*ts_out = ts;
		have = true;
	}
	obs_source_release(child);
	return have;
}

const char *program_name(void *)
{
	return obs_module_text("Source.Program");
}
void *program_create(obs_data_t *settings, obs_source_t *source)
{
	return wrapper_create(Kind::Program, settings, source);
}

// ---- Guest ----------------------------------------------------------------------

const char *guest_name(void *)
{
	return obs_module_text("Source.Guest");
}
void *guest_create(obs_data_t *settings, obs_source_t *source)
{
	return wrapper_create(Kind::Guest, settings, source);
}
void guest_defaults(obs_data_t *settings)
{
	obs_data_set_default_int(settings, "slot", 1);
	obs_data_set_default_string(settings, "content", "camera");
	obs_data_set_default_string(settings, "fit", "cover");
	obs_data_set_default_bool(settings, "names", false);
	obs_data_set_default_bool(settings, "always", false);
	obs_data_set_default_bool(settings, "audio", false);
}
obs_properties_t *guest_properties(void *)
{
	obs_properties_t *props = obs_properties_create();
	obs_properties_add_int(props, "slot", obs_module_text("Guest.Slot"), 1, 16, 1);
	obs_property_t *content = obs_properties_add_list(props, "content", obs_module_text("Guest.Content"),
							  OBS_COMBO_TYPE_LIST, OBS_COMBO_FORMAT_STRING);
	obs_property_list_add_string(content, obs_module_text("Guest.Content.Camera"), "camera");
	obs_property_list_add_string(content, obs_module_text("Guest.Content.Screen"), "screen");
	obs_property_t *fit = obs_properties_add_list(props, "fit", obs_module_text("Fit"), OBS_COMBO_TYPE_LIST,
						      OBS_COMBO_FORMAT_STRING);
	obs_property_list_add_string(fit, obs_module_text("Fit.Cover"), "cover");
	obs_property_list_add_string(fit, obs_module_text("Fit.Contain"), "contain");
	obs_properties_add_bool(props, "names", obs_module_text("Guest.Names"));
	obs_properties_add_bool(props, "always", obs_module_text("Guest.Always"));
	obs_properties_add_bool(props, "audio", obs_module_text("Guest.Audio"));
	obs_properties_add_text(props, "help", obs_module_text("Guest.Help"), OBS_TEXT_INFO);
	return props;
}

// ---- Screen share ---------------------------------------------------------------

const char *screen_name(void *)
{
	return obs_module_text("Source.Screen");
}
void *screen_create(obs_data_t *settings, obs_source_t *source)
{
	return wrapper_create(Kind::Screen, settings, source);
}
void screen_defaults(obs_data_t *settings)
{
	obs_data_set_default_string(settings, "fit", "contain");
}
obs_properties_t *screen_properties(void *)
{
	obs_properties_t *props = obs_properties_create();
	obs_property_t *fit = obs_properties_add_list(props, "fit", obs_module_text("Fit"), OBS_COMBO_TYPE_LIST,
						      OBS_COMBO_FORMAT_STRING);
	obs_property_list_add_string(fit, obs_module_text("Fit.Contain"), "contain");
	obs_property_list_add_string(fit, obs_module_text("Fit.Cover"), "cover");
	return props;
}

// ---- Audio ------------------------------------------------------------------------

const char *audio_name(void *)
{
	return obs_module_text("Source.Audio");
}
void *audio_create(obs_data_t *, obs_source_t *source)
{
	std::lock_guard<std::mutex> lock(audio_mutex);
	audio_sinks.insert(source);
	return source;
}
void audio_destroy(void *data)
{
	std::lock_guard<std::mutex> lock(audio_mutex);
	audio_sinks.erase(static_cast<obs_source_t *>(data));
}

obs_source_info video_wrapper_info(const char *id, uint32_t extra_flags)
{
	obs_source_info info = {};
	info.id = id;
	info.type = OBS_SOURCE_TYPE_INPUT;
	info.output_flags = OBS_SOURCE_VIDEO | OBS_SOURCE_CUSTOM_DRAW | OBS_SOURCE_INTERACTION | extra_flags;
	info.destroy = wrapper_destroy;
	info.update = wrapper_update;
	info.video_render = wrapper_render;
	info.get_width = wrapper_width;
	info.get_height = wrapper_height;
	info.mouse_click = wrapper_mouse_click;
	info.mouse_move = wrapper_mouse_move;
	info.mouse_wheel = wrapper_mouse_wheel;
	info.focus = wrapper_focus;
	info.key_click = wrapper_key_click;
	return info;
}

} // namespace

void register_sources()
{
	obs_source_info program =
		video_wrapper_info(PROGRAM_SOURCE_ID, OBS_SOURCE_DO_NOT_DUPLICATE | OBS_SOURCE_COMPOSITE);
	program.get_name = program_name;
	program.create = program_create;
	program.video_tick = program_tick;
	program.enum_active_sources = program_enum_active;
	program.audio_render = program_audio_render;
	program.icon_type = OBS_ICON_TYPE_BROWSER;
	obs_register_source(&program);

	obs_source_info guest = video_wrapper_info(GUEST_SOURCE_ID, OBS_SOURCE_AUDIO);
	guest.get_name = guest_name;
	guest.create = guest_create;
	guest.get_defaults = guest_defaults;
	guest.get_properties = guest_properties;
	guest.icon_type = OBS_ICON_TYPE_CAMERA;
	obs_register_source(&guest);

	obs_source_info screen = video_wrapper_info(SCREEN_SOURCE_ID, 0);
	screen.get_name = screen_name;
	screen.create = screen_create;
	screen.get_defaults = screen_defaults;
	screen.get_properties = screen_properties;
	screen.icon_type = OBS_ICON_TYPE_DESKTOP_CAPTURE;
	obs_register_source(&screen);

	obs_source_info audio = {};
	audio.id = AUDIO_SOURCE_ID;
	audio.type = OBS_SOURCE_TYPE_INPUT;
	// Hidden from Add Source: the plugin creates it and puts it on a global mixer channel.
	audio.output_flags = OBS_SOURCE_AUDIO | OBS_SOURCE_DO_NOT_DUPLICATE | OBS_SOURCE_CAP_DISABLED;
	audio.get_name = audio_name;
	audio.create = audio_create;
	audio.destroy = audio_destroy;
	audio.icon_type = OBS_ICON_TYPE_AUDIO_OUTPUT;
	obs_register_source(&audio);
}

void set_program_content(const std::string &source_name, bool has_rect, float x, float y, float w, float h)
{
	obs_source_t *src = (!source_name.empty() && has_rect) ? obs_get_source_by_name(source_name.c_str()) : nullptr;
	if (src && !(obs_source_get_output_flags(src) & OBS_SOURCE_VIDEO)) {
		obs_source_release(src);
		src = nullptr;
	}
	if (!source_name.empty() && has_rect && !src)
		obs_log(LOG_WARNING, "content source '%s' not found", source_name.c_str());
	std::lock_guard<std::mutex> lock(content_mutex);
	obs_weak_source_release(content_weak);
	content_weak = src ? obs_source_get_weak_source(src) : nullptr;
	if (src) {
		content_target[0] = x;
		content_target[1] = y;
		content_target[2] = w;
		content_target[3] = h;
	}
	obs_source_release(src);
}

void clear_program_content()
{
	std::lock_guard<std::mutex> lock(content_mutex);
	obs_weak_source_release(content_weak);
	content_weak = nullptr;
}

void set_base_url(const std::string &url)
{
	std::vector<obs_source_t *> refs;
	obs_source_t *program = nullptr;
	{
		std::lock_guard<std::mutex> lock(state_mutex);
		if (url == base_url)
			return;
		base_url = url;
		for (Wrapper *w : wrappers)
			if (w->kind != Kind::Program)
				refs.push_back(obs_source_get_ref(w->self));
		program = program_browser ? obs_source_get_ref(program_browser) : nullptr;
	}
	for (obs_source_t *src : refs) {
		if (!src)
			continue;
		// Re-applying the wrapper's own settings rebuilds its child URL from the new base.
		obs_data_t *settings = obs_source_get_settings(src);
		obs_source_update(src, settings);
		obs_data_release(settings);
		obs_source_release(src);
	}
	if (program) {
		obs_data_t *bs = browser_settings(url + "/output/program.html", true);
		obs_source_update(program, bs);
		obs_data_release(bs);
		obs_source_release(program);
	}
}

std::string get_base_url()
{
	return current_base();
}

void start_program_browser()
{
	std::string base = current_base();
	if (base.empty())
		return;
	std::string url = base + "/output/program.html";
	{
		std::lock_guard<std::mutex> lock(state_mutex);
		if (program_browser)
			return;
	}
	obs_data_t *bs = browser_settings(url, true);
	obs_source_t *browser = obs_source_create_private("browser_source", "studiohost-program-hub", bs);
	obs_data_release(bs);
	if (!browser) {
		obs_log(LOG_ERROR, "could not create the studio browser (is the OBS Browser plugin installed?)");
		return;
	}
	// Keep the page "visible" so Chromium never throttles it: guests depend on it even when
	// no Program source is in the current scene.
	obs_source_inc_showing(browser);
	obs_source_add_audio_capture_callback(browser, program_audio_cb, nullptr);
	std::lock_guard<std::mutex> lock(state_mutex);
	program_browser = browser;
}

void stop_program_browser()
{
	obs_source_t *browser;
	{
		std::lock_guard<std::mutex> lock(state_mutex);
		browser = program_browser;
		program_browser = nullptr;
	}
	if (!browser)
		return;
	obs_source_remove_audio_capture_callback(browser, program_audio_cb, nullptr);
	obs_source_dec_showing(browser);
	obs_source_release(browser);
}

namespace {
void reload_browser(obs_source_t *browser)
{
	obs_properties_t *props = obs_source_properties(browser);
	obs_property_t *button = obs_properties_get(props, "refreshnocache");
	if (button)
		obs_property_button_clicked(button, browser);
	obs_properties_destroy(props);
}
} // namespace

void reload_all_pages()
{
	std::vector<obs_source_t *> browsers;
	{
		std::lock_guard<std::mutex> lock(state_mutex);
		if (program_browser)
			browsers.push_back(obs_source_get_ref(program_browser));
		for (Wrapper *w : wrappers)
			if (w->child)
				browsers.push_back(obs_source_get_ref(w->child));
	}
	for (obs_source_t *b : browsers) {
		if (!b)
			continue;
		reload_browser(b);
		obs_source_release(b);
	}
}

bool program_browser_running()
{
	std::lock_guard<std::mutex> lock(state_mutex);
	return program_browser != nullptr;
}

} // namespace studiohost
