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
#include <string>

namespace studiohost {

// Source type ids.
constexpr const char *PROGRAM_SOURCE_ID = "studiohost_program"; // composited studio stage (video)
constexpr const char *GUEST_SOURCE_ID = "studiohost_guest";     // one guest slot (video, optional audio)
constexpr const char *SCREEN_SOURCE_ID = "studiohost_screen";   // featured screen share (video)
constexpr const char *AUDIO_SOURCE_ID = "studiohost_audio";     // studio program audio (global mixer channel)

void register_sources();

// Base URL of the local Studio Host server, e.g. "http://127.0.0.1:8730", set once the server
// is ready (pages stay blank until then). Changing it repoints every Studio Host source.
void set_base_url(const std::string &url);
std::string get_base_url();

// The studio hub: one hidden browser that every guest connects to. It composites the stage,
// produces the program audio and sends each guest their return feed. The plugin keeps it
// running (and "showing", so Chromium does not throttle it) whether or not any Program
// source is in the current scene.
void start_program_browser();
void stop_program_browser();
bool program_browser_running();

// The OBS source drawn as content inside Program sources (beneath the studio picture, which
// leaves that area transparent), at rectangle x,y,w,h given as fractions of the frame.
// An empty name or has_rect=false removes it.
void set_program_content(const std::string &source_name, bool has_rect, float x, float y, float w, float h);
void clear_program_content();

// Reloads every Studio Host page (studio hub and all guest/screen sources). Called when the
// server comes back after a restart, since pages may have hit a browser error page meanwhile.
void reload_all_pages();

} // namespace studiohost
