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

#include "studio-hotkeys.hpp"
#include "server-process.hpp"

#include <obs-module.h>

#include <QMetaObject>

namespace studiohost {

namespace {

constexpr int MAX_SLOTS = 16;
constexpr int PRESET_HOTKEYS = 9;

// A localized description with "%1" replaced by the slot (or preset) number.
std::string describe(const char *key, int number)
{
	std::string text = obs_module_text(key);
	size_t at = text.find("%1");
	if (at != std::string::npos)
		text.replace(at, 2, std::to_string(number));
	return text;
}

} // namespace

StudioHotkeys::StudioHotkeys(ServerProcess *server, obs_data_t *pluginConfig, QObject *parent)
	: QObject(parent),
	  server(server),
	  pluginConfig(pluginConfig)
{
	add("studiohost.next_banner", obs_module_text("Hotkey.NextBanner"), "nextBanner", 0);
	add("studiohost.hide_banner", obs_module_text("Hotkey.HideBanner"), "hideBanner", 0);
	add("studiohost.toggle_ticker", obs_module_text("Hotkey.Ticker"), "ticker", 0);
	add("studiohost.next_layout", obs_module_text("Hotkey.NextLayout"), "nextLayout", 0);
	add("studiohost.timer_pause", obs_module_text("Hotkey.Timer"), "timer", 0);
	for (int n = 1; n <= PRESET_HOTKEYS; n++)
		add("studiohost.preset_" + std::to_string(n), describe("Hotkey.Preset", n), "preset", n);
}

StudioHotkeys::~StudioHotkeys()
{
	for (Hotkey *h : hotkeys) {
		obs_hotkey_unregister(h->id);
		delete h;
	}
}

void StudioHotkeys::ensureSlots(int count)
{
	count = count > MAX_SLOTS ? MAX_SLOTS : count;
	for (int slot = registeredSlots + 1; slot <= count; slot++) {
		add("studiohost.stage_" + std::to_string(slot), describe("Hotkey.Stage", slot), "stage", slot);
		add("studiohost.mute_" + std::to_string(slot), describe("Hotkey.Mute", slot), "mute", slot);
	}
	if (count > registeredSlots)
		registeredSlots = count;
}

void StudioHotkeys::add(const std::string &name, const std::string &description, const std::string &action, int slot)
{
	auto *h = new Hotkey{OBS_INVALID_HOTKEY_ID, name, action, slot, this};
	h->id = obs_hotkey_register_frontend(name.c_str(), description.c_str(), pressed, h);
	obs_data_t *saved = obs_data_get_obj(pluginConfig, "hotkeys");
	obs_data_array_t *bindings = saved ? obs_data_get_array(saved, name.c_str()) : nullptr;
	if (bindings)
		obs_hotkey_load(h->id, bindings);
	obs_data_array_release(bindings);
	obs_data_release(saved);
	hotkeys.push_back(h);
}

void StudioHotkeys::save()
{
	obs_data_t *saved = obs_data_create();
	for (Hotkey *h : hotkeys) {
		obs_data_array_t *bindings = obs_hotkey_save(h->id);
		obs_data_set_array(saved, h->name.c_str(), bindings);
		obs_data_array_release(bindings);
	}
	obs_data_set_obj(pluginConfig, "hotkeys", saved);
	obs_data_release(saved);
}

// Runs on OBS's hotkey thread; the server is talked to from the UI thread.
void StudioHotkeys::pressed(void *data, obs_hotkey_id, obs_hotkey_t *, bool down)
{
	if (!down)
		return;
	auto *h = static_cast<Hotkey *>(data);
	StudioHotkeys *self = h->owner;
	std::string action = h->action;
	int slot = h->slot;
	QMetaObject::invokeMethod(self, [self, action, slot]() { self->send(action, slot); }, Qt::QueuedConnection);
}

void StudioHotkeys::send(const std::string &action, int slot)
{
	obs_data_t *msg = obs_data_create();
	obs_data_set_string(msg, "type", "hotkey");
	obs_data_set_string(msg, "action", action.c_str());
	if (slot)
		obs_data_set_int(msg, "slot", slot);
	server->send(QByteArray(obs_data_get_json(msg)));
	obs_data_release(msg);
}

} // namespace studiohost
