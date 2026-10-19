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

#include <string>
#include <vector>

namespace studiohost {

class ServerProcess;

// Producer actions as OBS hotkeys (Settings → Hotkeys, under "Studio Host: ..."), so a keyboard
// or a Stream Deck can run the show: bring guest N on or off stage, mute guest N, show the next
// banner, hide the banner, show or hide the ticker, switch to the next layout. A press is sent
// to the server, which acts on the studio as the dock would. Bindings are kept in plugin.json.
class StudioHotkeys : public QObject {
	Q_OBJECT

public:
	StudioHotkeys(ServerProcess *server, obs_data_t *pluginConfig, QObject *parent = nullptr);
	~StudioHotkeys() override;

	// Makes sure the per-guest hotkeys exist for slots 1..count (they are never removed while
	// OBS runs, so their bindings survive the slot count going down and up again).
	void ensureSlots(int count);
	// Copies the current bindings into the plugin config (the caller saves it).
	void save();

private:
	struct Hotkey {
		obs_hotkey_id id;
		std::string name;
		std::string action;
		int slot;
		StudioHotkeys *owner;
	};

	void add(const std::string &name, const std::string &description, const std::string &action, int slot);
	static void pressed(void *data, obs_hotkey_id id, obs_hotkey_t *hotkey, bool down);
	void send(const std::string &action, int slot);

	ServerProcess *server;
	obs_data_t *pluginConfig;
	std::vector<Hotkey *> hotkeys;
	int registeredSlots = 0;
};

} // namespace studiohost
