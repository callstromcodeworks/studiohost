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

#include <QByteArray>
#include <QObject>

#include <atomic>
#include <cstdint>
#include <map>
#include <string>

namespace studiohost {

class ServerProcess;

// One strip in the OBS audio mixer per guest in the studio, named "Studio Host: <name>". Its
// meter shows that guest's audio (from the studio hub, before volume and mute), and its fader
// and mute button are the guest's volume and mute in the program, kept in step with the dock.
// The strips are on no mixer track: the guests are already mixed into Studio Host Audio, so
// the strips only control and show them.
class GuestMixer : public QObject {
	Q_OBJECT

public:
	static constexpr const char *STRIP_SOURCE_ID = "studiohost_guest_strip";

	explicit GuestMixer(ServerProcess *server, QObject *parent = nullptr);
	~GuestMixer() override;

	// The server's guest list: [{id, name, volume, muted}]. Adds, updates and removes strips.
	void setGuests(obs_data_array_t *items);
	// A 'G' packet: participant id (36 bytes), uint32le sample rate, int16le mono samples.
	void pushAudio(const QByteArray &payload);
	// Puts the strips in the mixer once OBS has loaded (and after a scene collection change),
	// removing strips a scene collection saved from an earlier session.
	void attach();
	// Forgets the strips (OBS removes all sources when it changes scene collection or exits).
	void detach();

private:
	struct Strip {
		obs_source_t *source = nullptr;
		uint32_t channel = 0;
		std::string name;
		uint64_t nextTimestamp = 0;
		uint64_t lastLocalChange = 0; // when the producer last changed it in OBS
	};

	void addStrip(const std::string &id, const std::string &name, double volume, bool muted);
	void removeStrip(std::map<std::string, Strip>::iterator it);
	void apply(Strip &strip, double volume, bool muted);
	std::string uniqueName(const std::string &guestName, obs_source_t *self) const;
	void sendMix(const std::string &id, const char *key, double volume, bool muted);
	static void volumeChanged(void *data, calldata_t *cd);
	static void muteChanged(void *data, calldata_t *cd);
	static void mixersChanged(void *data, calldata_t *cd);
	const std::string *idOf(obs_source_t *source);

	ServerProcess *server;
	std::map<std::string, Strip> strips;
	obs_data_array_t *lastGuests = nullptr;
	bool attached = false;
	bool reapplyQueued = false;
	std::atomic<bool> applying = false; // set while copying the server's values onto a strip
};

// Registers the strip source type (call once, from obs_module_load).
void register_guest_strip_source();

} // namespace studiohost
