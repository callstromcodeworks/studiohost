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

#pragma once

#include <obs.h>

#include <QObject>
#include <QTimer>

#include <atomic>
#include <cstdint>
#include <memory>

namespace studiohost {

class ServerProcess;

// Sends what OBS is outputting to the server, for the studio hub to pass on to guests:
//  - the program picture, scaled down to at most FEED_MAX_WIDTH pixels wide (I420, at most 30 fps).
//    It comes from a private OBS canvas showing the program, so OBS scales and converts it on the
//    GPU and only the small picture is copied back; if that can't be set up, the main output is
//    scaled on the CPU instead.
//  - the audio of mixer track FEED_TRACK, which carries everything in OBS except Studio Host's
//    own guest audio (the plugin takes its sources off that track), so guests don't hear
//    themselves
// Runs only while the server asks for it (a guest is connected).
class ObsFeed : public QObject {
	Q_OBJECT

public:
	static constexpr int FEED_TRACK = 6; // 1-based, as shown in OBS
	static constexpr uint32_t FEED_MAX_WIDTH = 1280;
	static constexpr const char *FEED_OUTPUT_ID = "studiohost_feed_output";

	explicit ObsFeed(ServerProcess *server, QObject *parent = nullptr);
	~ObsFeed() override;

	void setEnabled(bool on);

	static void videoCallback(void *param, struct video_data *frame);

private:
	static void audioCallback(void *param, size_t mix, struct audio_data *data);
	static void channelChanged(void *param, calldata_t *data);
	bool startCanvas(const obs_video_info &ovi);
	void stopCanvas();
	void post(char kind, QByteArray &&payload, bool droppable);

	ServerProcess *server;
	bool enabled = false;
	uint32_t width = 0, height = 0, sampleRate = 48000;
	int frameDivider = 1;
	int frameCount = 0;
	obs_canvas_t *canvas = nullptr;
	obs_output_t *canvasOutput = nullptr;
	// Frames handed to the UI thread but not yet written; more than one means we're behind.
	std::shared_ptr<std::atomic<int>> videoInFlight = std::make_shared<std::atomic<int>>(0);
	QTimer trackTimer;
};

// Registers the output type that reads the guest-feed canvas (call once, from obs_module_load).
void register_feed_output();

// Takes Studio Host's audio sources (guest audio) off the feed track.
void keep_studiohost_audio_off_track(int track);

} // namespace studiohost
