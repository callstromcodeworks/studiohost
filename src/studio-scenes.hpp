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

// Renames built-in scenes and sources from older versions to their current names.
void rename_legacy_builtins();

// Creates any missing built-in scenes ("Studio Host: Studio", "Studio Host: Guest Screen Share",
// "Studio Host: Guest 1..slots"). Existing scenes are never modified. Returns a summary.
std::string ensure_builtin_scenes(int slots);

// Switches OBS to a built-in scene. kind is "studio", "screen" or "guest" (with slot).
// In Studio Mode the preview scene is changed instead. Returns false with an error message.
bool switch_to_builtin_scene(const std::string &kind, int slot, std::string &error);

// "studio", "screen", "guest:N", or "" when `scene_name` is not a built-in scene.
std::string builtin_id_for_scene(const char *scene_name);

// The "Studio Host Audio" source on a free global audio channel, so the program audio is in
// the mixer no matter which scene is live.
void attach_global_audio();
void detach_global_audio();

// Keeps one OBS Browser Source per web widget (Streamlabs alerts and the like) on top of the
// "Studio Host: Studio" scene. `items` is the server's list of {id, name, url, visible}; widget
// sources no longer in it are removed. Sources are found by an id in their private settings,
// so the producer can rename, move or resize them in OBS.
void sync_widgets(obs_data_array_t *items);

} // namespace studiohost
