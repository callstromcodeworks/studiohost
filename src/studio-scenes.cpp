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

#include "studio-scenes.hpp"
#include "studio-sources.hpp"

#include <obs-frontend-api.h>
#include <obs-module.h>
#include <plugin-support.h>
#include <graphics/vec2.h>

#include <cstdlib>
#include <cstring>
#include <set>
#include <string>
#include <vector>

namespace studiohost {
namespace {

const char *const SCENE_STUDIO = "Studio Host: Studio";
const char *const SCENE_SCREEN = "Studio Host: Guest Screen Share";
const char *const SCENE_SCREEN_OLD = "Studio Host: Screen Share"; // older versions
const char *const SCENE_GUEST_PREFIX = "Studio Host: Guest ";
const char *const SOURCE_PROGRAM = "Studio Host Program";
const char *const SOURCE_SCREEN = "Studio Host Guest Screen Share";
const char *const SOURCE_SCREEN_OLD = "Studio Host Screen Share"; // older versions
const char *const SOURCE_GUEST_PREFIX = "Studio Host Guest ";
const char *const SOURCE_AUDIO = "Studio Host Audio";
const char *const WIDGET_PREFIX = "Studio Host Widget: ";
const char *const WIDGET_KEY = "studiohost_widget"; // private setting holding the widget id

uint32_t audio_channel = 0; // 0 = not attached

std::string guest_scene_name(int slot)
{
	return SCENE_GUEST_PREFIX + std::to_string(slot);
}

// Returns a new reference to the source called `name` if it has type `id`, creating it if no
// source has that name. Returns nullptr (and logs) if the name is taken by another type.
obs_source_t *get_or_create_input(const char *id, const char *name, obs_data_t *settings)
{
	obs_source_t *src = obs_get_source_by_name(name);
	if (src) {
		if (strcmp(obs_source_get_unversioned_id(src), id) == 0)
			return src;
		obs_log(LOG_WARNING, "a source named '%s' already exists and is not a Studio Host source", name);
		obs_source_release(src);
		return nullptr;
	}
	return obs_source_create(id, name, settings, nullptr);
}

// Adds `src` to `scene`, scaled to fit the canvas.
void add_fullscreen(obs_scene_t *scene, obs_source_t *src)
{
	obs_sceneitem_t *item = obs_scene_add(scene, src);
	if (!item)
		return;
	obs_video_info ovi = {};
	obs_get_video_info(&ovi);
	vec2 pos;
	vec2_set(&pos, 0.0f, 0.0f);
	vec2 bounds;
	vec2_set(&bounds, (float)(ovi.base_width ? ovi.base_width : 1920),
		 (float)(ovi.base_height ? ovi.base_height : 1080));
	obs_sceneitem_set_alignment(item, OBS_ALIGN_LEFT | OBS_ALIGN_TOP);
	obs_sceneitem_set_pos(item, &pos);
	obs_sceneitem_set_bounds_type(item, OBS_BOUNDS_SCALE_INNER);
	obs_sceneitem_set_bounds_alignment(item, OBS_ALIGN_CENTER);
	obs_sceneitem_set_bounds(item, &bounds);
}

// Creates scene `scene_name` holding one full-canvas source, unless the scene already exists.
bool ensure_scene(const char *scene_name, const char *source_id, const char *source_name, obs_data_t *settings)
{
	obs_source_t *existing = obs_get_source_by_name(scene_name);
	if (existing) {
		obs_source_release(existing);
		return false;
	}
	obs_source_t *src = get_or_create_input(source_id, source_name, settings);
	if (!src)
		return false;
	obs_scene_t *scene = obs_scene_create(scene_name);
	add_fullscreen(scene, src);
	obs_scene_release(scene);
	obs_source_release(src);
	return true;
}

// Renames source `from` to `to` (scenes are sources too) if `from` exists and `to` is free.
void rename_if_present(const char *from, const char *to)
{
	obs_source_t *src = obs_get_source_by_name(from);
	if (!src)
		return;
	obs_source_t *taken = obs_get_source_by_name(to);
	if (!taken)
		obs_source_set_name(src, to);
	obs_source_release(taken);
	obs_source_release(src);
}

} // namespace

void rename_legacy_builtins()
{
	// Older versions called these "Screen Share", which read as the producer's own screen.
	rename_if_present(SCENE_SCREEN_OLD, SCENE_SCREEN);
	rename_if_present(SOURCE_SCREEN_OLD, SOURCE_SCREEN);
}

std::string ensure_builtin_scenes(int slots)
{
	rename_legacy_builtins();
	int created = 0;
	if (ensure_scene(SCENE_STUDIO, PROGRAM_SOURCE_ID, SOURCE_PROGRAM, nullptr))
		created++;
	if (ensure_scene(SCENE_SCREEN, SCREEN_SOURCE_ID, SOURCE_SCREEN, nullptr))
		created++;
	for (int i = 1; i <= slots; i++) {
		obs_data_t *s = obs_data_create();
		obs_data_set_int(s, "slot", i);
		obs_data_set_bool(s, "always", true); // switching to a guest's scene should show them
		std::string scene = guest_scene_name(i);
		std::string source = SOURCE_GUEST_PREFIX + std::to_string(i);
		if (ensure_scene(scene.c_str(), GUEST_SOURCE_ID, source.c_str(), s))
			created++;
		obs_data_release(s);
	}
	if (created == 0)
		return "All built-in scenes already exist.";
	return "Created " + std::to_string(created) + (created == 1 ? " scene." : " scenes.");
}

bool switch_to_builtin_scene(const std::string &kind, int slot, std::string &error)
{
	std::string name;
	if (kind == "studio")
		name = SCENE_STUDIO;
	else if (kind == "screen")
		name = SCENE_SCREEN;
	else if (kind == "guest" && slot >= 1)
		name = guest_scene_name(slot);
	else {
		error = "Unknown scene.";
		return false;
	}
	obs_source_t *scene = obs_get_source_by_name(name.c_str());
	if (!scene && kind == "screen")
		scene = obs_get_source_by_name(SCENE_SCREEN_OLD);
	if (!scene || !obs_scene_from_source(scene)) {
		obs_source_release(scene);
		error = "The scene \"" + name + "\" doesn't exist. Use Create built-in scenes in the Setup tab.";
		return false;
	}
	if (obs_frontend_preview_program_mode_active())
		obs_frontend_set_current_preview_scene(scene);
	else
		obs_frontend_set_current_scene(scene);
	obs_source_release(scene);
	return true;
}

std::string builtin_id_for_scene(const char *scene_name)
{
	if (!scene_name)
		return "";
	if (strcmp(scene_name, SCENE_STUDIO) == 0)
		return "studio";
	if (strcmp(scene_name, SCENE_SCREEN) == 0 || strcmp(scene_name, SCENE_SCREEN_OLD) == 0)
		return "screen";
	size_t prefix = strlen(SCENE_GUEST_PREFIX);
	if (strncmp(scene_name, SCENE_GUEST_PREFIX, prefix) == 0) {
		char *end = nullptr;
		long n = strtol(scene_name + prefix, &end, 10);
		if (n > 0 && end && *end == '\0')
			return "guest:" + std::to_string(n);
	}
	return "";
}

void attach_global_audio()
{
	if (audio_channel)
		return;
	obs_source_t *audio = get_or_create_input(AUDIO_SOURCE_ID, SOURCE_AUDIO, nullptr);
	if (!audio)
		return;
	// Channels 1-6 belong to OBS's desktop/mic devices; take the highest free one.
	for (uint32_t ch = MAX_CHANNELS - 1; ch > 6; ch--) {
		obs_source_t *current = obs_get_output_source(ch);
		bool ours = current == audio;
		bool free_slot = current == nullptr;
		obs_source_release(current);
		if (ours || free_slot) {
			if (free_slot)
				obs_set_output_source(ch, audio);
			audio_channel = ch;
			break;
		}
	}
	if (!audio_channel)
		obs_log(LOG_WARNING, "no free global audio channel for Studio Host Audio");
	obs_source_release(audio);
}

void detach_global_audio()
{
	if (!audio_channel)
		return;
	obs_set_output_source(audio_channel, nullptr);
	audio_channel = 0;
}

// ---- web widgets ----------------------------------------------------------------------

namespace {

// The widget id stored on `src`, or "" when it is not a Studio Host widget.
std::string widget_id(obs_source_t *src)
{
	obs_data_t *priv = obs_source_get_private_settings(src);
	std::string id = priv ? obs_data_get_string(priv, WIDGET_KEY) : "";
	obs_data_release(priv);
	return id;
}

// New references to every widget source in the current collection.
std::vector<obs_source_t *> widget_sources()
{
	std::vector<obs_source_t *> found;
	obs_enum_sources(
		[](void *param, obs_source_t *src) {
			if (!obs_source_removed(src) && !widget_id(src).empty()) {
				obs_source_t *ref = obs_source_get_ref(src);
				if (ref)
					static_cast<std::vector<obs_source_t *> *>(param)->push_back(ref);
			}
			return true;
		},
		&found);
	return found;
}

// `base`, or `base (2)`, `base (3)`… whichever no other source uses.
std::string free_source_name(const std::string &base)
{
	std::string name = base;
	for (int n = 2; n < 100; n++) {
		obs_source_t *taken = obs_get_source_by_name(name.c_str());
		if (!taken)
			break;
		obs_source_release(taken);
		name = base + " (" + std::to_string(n) + ")";
	}
	return name;
}

// The item showing `src` in `scene` (owned by the scene), or nullptr.
obs_sceneitem_t *scene_item_for(obs_scene_t *scene, obs_source_t *src)
{
	struct Find {
		obs_source_t *src;
		obs_sceneitem_t *item;
	} find = {src, nullptr};
	obs_scene_enum_items(
		scene,
		[](obs_scene_t *, obs_sceneitem_t *item, void *param) {
			auto *f = static_cast<Find *>(param);
			if (obs_sceneitem_get_source(item) != f->src)
				return true;
			f->item = item;
			return false;
		},
		&find);
	return find.item;
}

// Removes every scene item showing `src`, in all scenes of the current collection.
void remove_scene_items_of(obs_source_t *src)
{
	struct Find {
		obs_source_t *src;
		std::vector<obs_sceneitem_t *> items;
	} find = {src, {}};
	obs_frontend_source_list scenes = {};
	obs_frontend_get_scenes(&scenes);
	for (size_t i = 0; i < scenes.sources.num; i++) {
		obs_scene_t *scene = obs_scene_from_source(scenes.sources.array[i]);
		if (!scene)
			continue;
		obs_scene_enum_items(
			scene,
			[](obs_scene_t *, obs_sceneitem_t *item, void *param) {
				auto *f = static_cast<Find *>(param);
				if (obs_sceneitem_get_source(item) == f->src) {
					obs_sceneitem_addref(item);
					f->items.push_back(item);
				}
				return true;
			},
			&find);
	}
	obs_frontend_source_list_free(&scenes);
	for (obs_sceneitem_t *item : find.items) {
		obs_sceneitem_remove(item);
		obs_sceneitem_release(item);
	}
}

obs_source_t *create_widget_source(const char *id, const char *name, const char *url)
{
	obs_video_info ovi = {};
	obs_get_video_info(&ovi);
	obs_data_t *bs = obs_data_create();
	obs_data_set_string(bs, "url", url);
	obs_data_set_int(bs, "width", ovi.base_width ? ovi.base_width : 1920);
	obs_data_set_int(bs, "height", ovi.base_height ? ovi.base_height : 1080);
	obs_data_set_bool(bs, "reroute_audio", true); // alert sounds show up in the OBS mixer
	obs_data_set_bool(bs, "shutdown", false);     // keep listening for events while hidden
	std::string sourceName = free_source_name(std::string(WIDGET_PREFIX) + name);
	obs_source_t *src = obs_source_create("browser_source", sourceName.c_str(), bs, nullptr);
	obs_data_release(bs);
	if (!src)
		return nullptr;
	obs_data_t *priv = obs_source_get_private_settings(src);
	obs_data_set_string(priv, WIDGET_KEY, id);
	obs_data_release(priv);
	return src;
}

} // namespace

void sync_widgets(obs_data_array_t *items)
{
	obs_source_t *studioSource = obs_get_source_by_name(SCENE_STUDIO);
	obs_scene_t *studio = studioSource ? obs_scene_from_source(studioSource) : nullptr;
	std::vector<obs_source_t *> existing = widget_sources();
	std::set<std::string> wanted;

	size_t count = items ? obs_data_array_count(items) : 0;
	for (size_t i = 0; i < count; i++) {
		obs_data_t *item = obs_data_array_item(items, i);
		std::string id = obs_data_get_string(item, "id");
		const char *name = obs_data_get_string(item, "name");
		const char *url = obs_data_get_string(item, "url");
		bool visible = obs_data_get_bool(item, "visible");
		obs_data_release(item);
		if (id.empty() || !*url)
			continue;
		wanted.insert(id);

		obs_source_t *src = nullptr;
		for (obs_source_t *s : existing)
			if (widget_id(s) == id)
				src = obs_source_get_ref(s);
		if (src) {
			obs_data_t *settings = obs_source_get_settings(src);
			if (strcmp(obs_data_get_string(settings, "url"), url) != 0) {
				obs_data_t *patch = obs_data_create();
				obs_data_set_string(patch, "url", url);
				obs_source_update(src, patch);
				obs_data_release(patch);
			}
			obs_data_release(settings);
		} else if (studio) {
			src = create_widget_source(id.c_str(), name, url);
		}
		if (!src) {
			obs_log(LOG_WARNING, "widget '%s' not added: the scene \"%s\" doesn't exist", name,
				SCENE_STUDIO);
			continue;
		}
		if (studio) {
			obs_sceneitem_t *sceneItem = scene_item_for(studio, src);
			// New, or removed from the scene in OBS: put it back on top of the stage.
			if (!sceneItem)
				sceneItem = obs_scene_add(studio, src);
			if (sceneItem && obs_sceneitem_visible(sceneItem) != visible)
				obs_sceneitem_set_visible(sceneItem, visible);
		}
		obs_source_release(src);
	}

	// Widgets deleted in the dock: take them out of every scene, then remove their sources.
	for (obs_source_t *s : existing) {
		if (!wanted.count(widget_id(s))) {
			remove_scene_items_of(s);
			obs_source_remove(s);
		}
		obs_source_release(s);
	}
	obs_source_release(studioSource);
}

} // namespace studiohost
