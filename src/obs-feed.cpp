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

#include "obs-feed.hpp"
#include "server-process.hpp"
#include "studio-sources.hpp"

#include <obs.h>
#include <plugin-support.h>
#include <media-io/audio-io.h>
#include <media-io/video-io.h>

#include <QByteArray>
#include <QMetaObject>

#include <algorithm>
#include <cstring>

namespace studiohost {

namespace {

void put16(char *p, uint32_t v)
{
	p[0] = static_cast<char>(v & 0xff);
	p[1] = static_cast<char>((v >> 8) & 0xff);
}

void put32(char *p, uint32_t v)
{
	put16(p, v & 0xffff);
	put16(p + 2, v >> 16);
}

// A video-only output that hands the guest-feed canvas's frames to ObsFeed::videoCallback.
struct FeedOutput {
	obs_output_t *output;
	void *feed;
};

} // namespace

void register_feed_output()
{
	obs_output_info info = {};
	info.id = ObsFeed::FEED_OUTPUT_ID;
	info.flags = OBS_OUTPUT_VIDEO;
	info.get_name = [](void *) {
		return "Studio Host guest feed";
	};
	info.create = [](obs_data_t *settings, obs_output_t *output) -> void * {
		return new FeedOutput{output, reinterpret_cast<void *>(obs_data_get_int(settings, "feed"))};
	};
	info.destroy = [](void *data) {
		delete static_cast<FeedOutput *>(data);
	};
	info.start = [](void *data) {
		auto *out = static_cast<FeedOutput *>(data);
		return obs_output_can_begin_data_capture(out->output, 0) &&
		       obs_output_begin_data_capture(out->output, 0);
	};
	info.stop = [](void *data, uint64_t) {
		obs_output_end_data_capture(static_cast<FeedOutput *>(data)->output);
	};
	info.raw_video = [](void *data, struct video_data *frame) {
		ObsFeed::videoCallback(static_cast<FeedOutput *>(data)->feed, frame);
	};
	obs_register_output(&info);
}

void keep_studiohost_audio_off_track(int track)
{
	uint32_t bit = 1u << (track - 1);
	obs_enum_sources(
		[](void *param, obs_source_t *src) {
			const char *id = obs_source_get_unversioned_id(src);
			if (id && (strcmp(id, AUDIO_SOURCE_ID) == 0 || strcmp(id, GUEST_SOURCE_ID) == 0)) {
				uint32_t bit = *static_cast<uint32_t *>(param);
				uint32_t mixers = obs_source_get_audio_mixers(src);
				if (mixers & bit)
					obs_source_set_audio_mixers(src, mixers & ~bit);
			}
			return true;
		},
		&bit);
}

ObsFeed::ObsFeed(ServerProcess *server_, QObject *parent) : QObject(parent), server(server_)
{
	// Guest sources can be added at any time; keep them off the feed track while it runs.
	trackTimer.setInterval(2000);
	connect(&trackTimer, &QTimer::timeout, this, []() { keep_studiohost_audio_off_track(FEED_TRACK); });
}

ObsFeed::~ObsFeed()
{
	setEnabled(false);
}

void ObsFeed::setEnabled(bool on)
{
	if (on == enabled)
		return;
	if (!on) {
		// Both calls wait for a callback in progress to finish, so none runs after this.
		if (canvas)
			stopCanvas();
		else
			obs_remove_raw_video_callback(videoCallback, this);
		obs_remove_raw_audio_callback(FEED_TRACK - 1, audioCallback, this);
		trackTimer.stop();
		enabled = false;
		obs_log(LOG_INFO, "OBS feed to guests stopped");
		return;
	}

	obs_video_info ovi = {};
	if (!obs_get_video_info(&ovi) || !ovi.output_width || !ovi.output_height) {
		obs_log(LOG_WARNING, "OBS feed to guests not started: no video output");
		return;
	}
	width = std::min<uint32_t>(FEED_MAX_WIDTH, ovi.output_width) & ~1u;
	height = (static_cast<uint32_t>(static_cast<uint64_t>(width) * ovi.output_height / ovi.output_width) + 1) & ~1u;
	double fps = ovi.fps_den ? static_cast<double>(ovi.fps_num) / ovi.fps_den : 30.0;
	frameDivider = fps > 30.5 ? static_cast<int>(fps / 30.0 + 0.5) : 1;
	frameCount = 0;

	keep_studiohost_audio_off_track(FEED_TRACK);
	trackTimer.start();

	if (!startCanvas(ovi)) {
		video_scale_info vconv = {};
		vconv.format = VIDEO_FORMAT_I420;
		vconv.width = width;
		vconv.height = height;
		vconv.range = VIDEO_RANGE_PARTIAL;
		vconv.colorspace = VIDEO_CS_709;
		obs_add_raw_video_callback(&vconv, videoCallback, this);
	}

	obs_audio_info oai = {};
	sampleRate = obs_get_audio_info(&oai) && oai.samples_per_sec ? oai.samples_per_sec : 48000;
	audio_convert_info aconv = {};
	aconv.samples_per_sec = sampleRate;
	aconv.format = AUDIO_FORMAT_FLOAT;
	aconv.speakers = SPEAKERS_STEREO;
	obs_add_raw_audio_callback(FEED_TRACK - 1, &aconv, audioCallback, this);

	enabled = true;
	obs_log(LOG_INFO, "OBS feed to guests started (%ux%u, scaled on the %s, track %d audio)", width, height,
		canvas ? "GPU" : "CPU", FEED_TRACK);
}

// A private canvas showing the program at the feed size, read through a video-only output.
bool ObsFeed::startCanvas(const obs_video_info &ovi)
{
	obs_video_info fovi = ovi;
	fovi.output_width = width;
	fovi.output_height = height;
	fovi.output_format = VIDEO_FORMAT_I420;
	fovi.colorspace = VIDEO_CS_709;
	fovi.range = VIDEO_RANGE_PARTIAL;
	fovi.gpu_conversion = true;
	fovi.scale_type = OBS_SCALE_BILINEAR;
	canvas = obs_canvas_create_private("Studio Host guest feed", &fovi, 0);
	if (!canvas || !obs_canvas_has_video(canvas)) {
		obs_log(LOG_WARNING, "OBS feed to guests: no GPU canvas, scaling on the CPU");
		stopCanvas();
		return false;
	}
	obs_source_t *program = obs_get_output_source(0);
	obs_canvas_set_channel(canvas, 0, program);
	obs_source_release(program);
	signal_handler_connect(obs_get_signal_handler(), "channel_change", channelChanged, this);

	obs_data_t *settings = obs_data_create();
	obs_data_set_int(settings, "feed", reinterpret_cast<intptr_t>(this));
	canvasOutput = obs_output_create(FEED_OUTPUT_ID, "Studio Host guest feed", settings, nullptr);
	obs_data_release(settings);
	if (canvasOutput) {
		obs_output_set_media(canvasOutput, obs_canvas_get_video(canvas), nullptr);
		if (obs_output_start(canvasOutput))
			return true;
	}
	obs_log(LOG_WARNING, "OBS feed to guests: GPU canvas output didn't start, scaling on the CPU");
	stopCanvas();
	return false;
}

void ObsFeed::stopCanvas()
{
	if (canvasOutput) {
		obs_output_stop(canvasOutput);
		obs_output_release(canvasOutput);
		canvasOutput = nullptr;
	}
	if (canvas) {
		signal_handler_disconnect(obs_get_signal_handler(), "channel_change", channelChanged, this);
		obs_canvas_set_channel(canvas, 0, nullptr);
		obs_canvas_remove(canvas);
		obs_canvas_release(canvas);
		canvas = nullptr;
	}
}

// The program's transition was replaced (for example a different transition type); follow it.
void ObsFeed::channelChanged(void *param, calldata_t *data)
{
	auto *self = static_cast<ObsFeed *>(param);
	if (calldata_int(data, "channel") != 0 || !self->canvas)
		return;
	obs_canvas_set_channel(self->canvas, 0, static_cast<obs_source_t *>(calldata_ptr(data, "source")));
}

// OBS video thread.
void ObsFeed::videoCallback(void *param, struct video_data *frame)
{
	auto *self = static_cast<ObsFeed *>(param);
	if (self->frameCount++ % self->frameDivider != 0)
		return;
	if (self->videoInFlight->load() > 1)
		return; // the UI thread hasn't caught up; skip this frame
	const uint32_t w = self->width, h = self->height;
	const uint32_t cw = w / 2, ch = h / 2;
	QByteArray payload(static_cast<qsizetype>(4 + w * h + 2 * cw * ch), Qt::Uninitialized);
	char *out = payload.data();
	put16(out, w);
	put16(out + 2, h);
	out += 4;
	const uint32_t widths[3] = {w, cw, cw}, heights[3] = {h, ch, ch};
	for (int plane = 0; plane < 3; plane++) {
		const uint8_t *src = frame->data[plane];
		for (uint32_t y = 0; y < heights[plane]; y++) {
			memcpy(out, src + static_cast<size_t>(y) * frame->linesize[plane], widths[plane]);
			out += widths[plane];
		}
	}
	self->post('V', std::move(payload), true);
}

// OBS audio thread.
void ObsFeed::audioCallback(void *param, size_t, struct audio_data *data)
{
	auto *self = static_cast<ObsFeed *>(param);
	const qsizetype bytes = static_cast<qsizetype>(data->frames) * 2 * sizeof(float);
	QByteArray payload(4 + bytes, Qt::Uninitialized);
	put32(payload.data(), self->sampleRate);
	memcpy(payload.data() + 4, data->data[0], static_cast<size_t>(bytes));
	self->post('A', std::move(payload), false);
}

void ObsFeed::post(char kind, QByteArray &&payload, bool droppable)
{
	// QProcess lives on the UI thread; hand the packet over. If the server object is gone
	// by then, Qt drops the call.
	ServerProcess *target = server;
	auto inFlight = videoInFlight;
	if (droppable)
		++*inFlight;
	QMetaObject::invokeMethod(
		target,
		[target, kind, droppable, inFlight, data = std::move(payload)]() {
			target->sendPacket(kind, data, droppable);
			if (droppable)
				--*inFlight;
		},
		Qt::QueuedConnection);
}

} // namespace studiohost
