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

#include "guest-mixer.hpp"
#include "server-process.hpp"

#include <obs-module.h>
#include <plugin-support.h>
#include <util/platform.h>

#include <QMetaObject>
#include <QTimer>

#include <cmath>
#include <cstring>
#include <set>
#include <vector>

namespace studiohost {

namespace {

constexpr int ID_LENGTH = 36;
constexpr uint32_t FIRST_FREE_CHANNEL = 7; // channels 1-6 belong to OBS's desktop/mic devices
const char *const STRIP_PREFIX = "Studio Host: ";

uint32_t get32(const char *p)
{
	auto b = reinterpret_cast<const unsigned char *>(p);
	return b[0] | (b[1] << 8) | (b[2] << 16) | (static_cast<uint32_t>(b[3]) << 24);
}

// While the producer is moving a strip's fader, the server's echoes of earlier positions are
// held back (they would make the fader jump back) and the latest value applied afterwards.
constexpr uint64_t LOCAL_CHANGE_HOLD_NS = 500000000ULL;

} // namespace

void register_guest_strip_source()
{
	obs_source_info info = {};
	info.id = GuestMixer::STRIP_SOURCE_ID;
	info.type = OBS_SOURCE_TYPE_INPUT;
	// Hidden from Add Source: the plugin makes one per guest.
	info.output_flags = OBS_SOURCE_AUDIO | OBS_SOURCE_DO_NOT_DUPLICATE | OBS_SOURCE_CAP_DISABLED;
	info.get_name = [](void *) {
		return obs_module_text("Source.GuestStrip");
	};
	info.create = [](obs_data_t *, obs_source_t *source) -> void * {
		return source;
	};
	info.destroy = [](void *) {
	};
	info.icon_type = OBS_ICON_TYPE_AUDIO_INPUT;
	obs_register_source(&info);
}

GuestMixer::GuestMixer(ServerProcess *server, QObject *parent) : QObject(parent), server(server) {}

GuestMixer::~GuestMixer()
{
	detach();
	obs_data_array_release(lastGuests);
}

void GuestMixer::attach()
{
	if (attached)
		return;
	attached = true;
	// A scene collection saves the strips like any source; those from an earlier session are
	// not on a mixer channel and belong to nobody, so remove them.
	std::vector<obs_source_t *> stale;
	obs_enum_sources(
		[](void *param, obs_source_t *src) {
			if (strcmp(obs_source_get_unversioned_id(src), STRIP_SOURCE_ID) == 0)
				static_cast<std::vector<obs_source_t *> *>(param)->push_back(obs_source_get_ref(src));
			return true;
		},
		&stale);
	for (obs_source_t *src : stale) {
		obs_source_remove(src);
		obs_source_release(src);
	}
	if (lastGuests)
		setGuests(lastGuests);
}

void GuestMixer::detach()
{
	attached = false;
	while (!strips.empty())
		removeStrip(strips.begin());
}

void GuestMixer::setGuests(obs_data_array_t *items)
{
	if (items != lastGuests) {
		obs_data_array_addref(items);
		obs_data_array_release(lastGuests);
		lastGuests = items;
	}
	if (!attached)
		return;
	std::set<std::string> present;
	size_t count = obs_data_array_count(items);
	for (size_t i = 0; i < count; i++) {
		obs_data_t *item = obs_data_array_item(items, i);
		std::string id = obs_data_get_string(item, "id");
		std::string name = obs_data_get_string(item, "name");
		double volume = obs_data_get_double(item, "volume");
		bool muted = obs_data_get_bool(item, "muted");
		obs_data_release(item);
		if (id.size() != ID_LENGTH)
			continue;
		present.insert(id);
		auto it = strips.find(id);
		if (it == strips.end()) {
			addStrip(id, name, volume, muted);
			continue;
		}
		Strip &strip = it->second;
		if (strip.name != name) {
			strip.name = name;
			obs_source_set_name(strip.source, uniqueName(name, strip.source).c_str());
		}
		apply(strip, volume, muted);
	}
	for (auto it = strips.begin(); it != strips.end();) {
		auto next = std::next(it);
		if (!present.count(it->first))
			removeStrip(it);
		it = next;
	}
}

void GuestMixer::addStrip(const std::string &id, const std::string &name, double volume, bool muted)
{
	uint32_t channel = 0;
	for (uint32_t ch = MAX_CHANNELS - 1; ch >= FIRST_FREE_CHANNEL; ch--) {
		obs_source_t *current = obs_get_output_source(ch);
		obs_source_release(current);
		if (!current) {
			channel = ch;
			break;
		}
	}
	if (!channel) {
		obs_log(LOG_WARNING, "no free mixer channel for guest '%s'", name.c_str());
		return;
	}
	obs_source_t *src = obs_source_create(STRIP_SOURCE_ID, uniqueName(name, nullptr).c_str(), nullptr, nullptr);
	if (!src)
		return;
	// Already in the program through Studio Host Audio: on no track, and not monitored.
	obs_source_set_audio_mixers(src, 0);
	obs_source_set_monitoring_type(src, OBS_MONITORING_TYPE_NONE);
	signal_handler_t *sh = obs_source_get_signal_handler(src);
	signal_handler_connect(sh, "volume", volumeChanged, this);
	signal_handler_connect(sh, "mute", muteChanged, this);
	signal_handler_connect(sh, "audio_mixers", mixersChanged, this);

	Strip &strip = strips[id];
	strip.source = src;
	strip.channel = channel;
	strip.name = name;
	apply(strip, volume, muted);
	obs_set_output_source(channel, src);
}

void GuestMixer::removeStrip(std::map<std::string, Strip>::iterator it)
{
	Strip &strip = it->second;
	signal_handler_t *sh = obs_source_get_signal_handler(strip.source);
	signal_handler_disconnect(sh, "volume", volumeChanged, this);
	signal_handler_disconnect(sh, "mute", muteChanged, this);
	signal_handler_disconnect(sh, "audio_mixers", mixersChanged, this);
	obs_source_t *current = obs_get_output_source(strip.channel);
	if (current == strip.source)
		obs_set_output_source(strip.channel, nullptr);
	obs_source_release(current);
	obs_source_remove(strip.source);
	obs_source_release(strip.source);
	strips.erase(it);
}

void GuestMixer::apply(Strip &strip, double volume, bool muted)
{
	applying = true;
	if (obs_source_muted(strip.source) != muted)
		obs_source_set_muted(strip.source, muted);
	uint64_t sinceLocal = os_gettime_ns() - strip.lastLocalChange;
	if (sinceLocal < LOCAL_CHANGE_HOLD_NS) {
		// Try again once the producer has let go of the fader.
		if (!reapplyQueued) {
			reapplyQueued = true;
			QTimer::singleShot(static_cast<int>((LOCAL_CHANGE_HOLD_NS - sinceLocal) / 1000000) + 50, this,
					   [this]() {
						   reapplyQueued = false;
						   if (attached && lastGuests)
							   setGuests(lastGuests);
					   });
		}
	} else if (std::fabs(obs_source_get_volume(strip.source) - volume) > 0.0005) {
		obs_source_set_volume(strip.source, static_cast<float>(volume));
	}
	applying = false;
}

// "Studio Host: <name>", with a number added if another source already has that name.
std::string GuestMixer::uniqueName(const std::string &guestName, obs_source_t *self) const
{
	std::string base = STRIP_PREFIX + (guestName.empty() ? std::string("Guest") : guestName);
	std::string name = base;
	for (int n = 2;; n++) {
		obs_source_t *taken = obs_get_source_by_name(name.c_str());
		obs_source_release(taken);
		if (!taken || taken == self)
			return name;
		name = base + " (" + std::to_string(n) + ")";
	}
}

void GuestMixer::pushAudio(const QByteArray &payload)
{
	if (payload.size() < ID_LENGTH + 4 + 2)
		return;
	auto it = strips.find(std::string(payload.constData(), ID_LENGTH));
	if (it == strips.end())
		return;
	Strip &strip = it->second;
	uint32_t rate = get32(payload.constData() + ID_LENGTH);
	uint32_t frames = static_cast<uint32_t>((payload.size() - ID_LENGTH - 4) / 2);
	if (rate < 8000 || rate > 192000)
		return;
	// The audio arrives in uneven bursts; give OBS evenly spaced timestamps unless it has
	// drifted far from the clock (a gap, or a backlog).
	uint64_t now = os_gettime_ns();
	uint64_t drift = strip.nextTimestamp > now ? strip.nextTimestamp - now : now - strip.nextTimestamp;
	if (drift > 100000000ULL)
		strip.nextTimestamp = now;
	obs_source_audio audio = {};
	audio.data[0] = reinterpret_cast<const uint8_t *>(payload.constData() + ID_LENGTH + 4);
	audio.frames = frames;
	audio.speakers = SPEAKERS_MONO;
	audio.format = AUDIO_FORMAT_16BIT;
	audio.samples_per_sec = rate;
	audio.timestamp = strip.nextTimestamp;
	strip.nextTimestamp += static_cast<uint64_t>(frames) * 1000000000ULL / rate;
	obs_source_output_audio(strip.source, &audio);
}

// Strip changes come in on OBS's signal threads and are handled on the UI thread, where the
// strips live; a strip is looked up again there, since it may have been removed meanwhile.
const std::string *GuestMixer::idOf(obs_source_t *source)
{
	for (auto &[id, strip] : strips) {
		if (strip.source == source) {
			strip.lastLocalChange = os_gettime_ns();
			return &id;
		}
	}
	return nullptr;
}

void GuestMixer::sendMix(const std::string &id, const char *key, double volume, bool muted)
{
	obs_data_t *msg = obs_data_create();
	obs_data_set_string(msg, "type", "guest-mix");
	obs_data_set_string(msg, "id", id.c_str());
	if (strcmp(key, "volume") == 0)
		obs_data_set_double(msg, "volume", volume);
	else
		obs_data_set_bool(msg, "muted", muted);
	server->send(QByteArray(obs_data_get_json(msg)));
	obs_data_release(msg);
}

void GuestMixer::volumeChanged(void *data, calldata_t *cd)
{
	auto *self = static_cast<GuestMixer *>(data);
	if (self->applying)
		return;
	auto *source = static_cast<obs_source_t *>(calldata_ptr(cd, "source"));
	double volume = calldata_float(cd, "volume");
	QMetaObject::invokeMethod(
		self,
		[self, source, volume]() {
			if (const std::string *id = self->idOf(source))
				self->sendMix(*id, "volume", volume, false);
		},
		Qt::QueuedConnection);
}

void GuestMixer::muteChanged(void *data, calldata_t *cd)
{
	auto *self = static_cast<GuestMixer *>(data);
	if (self->applying)
		return;
	auto *source = static_cast<obs_source_t *>(calldata_ptr(cd, "source"));
	bool muted = calldata_bool(cd, "muted");
	QMetaObject::invokeMethod(
		self,
		[self, source, muted]() {
			if (const std::string *id = self->idOf(source))
				self->sendMix(*id, "muted", 0.0, muted);
		},
		Qt::QueuedConnection);
}

// The guests are already in the program; putting a strip on a track would play them twice.
// OBS reads the value back from the signal, so the strip stays on no track.
void GuestMixer::mixersChanged(void *, calldata_t *cd)
{
	calldata_set_int(cd, "mixers", 0);
}

} // namespace studiohost
