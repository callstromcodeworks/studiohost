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
#include <obs-frontend-api.h>

#include <QByteArray>
#include <QDialog>
#include <QObject>
#include <QString>
#include <QTimer>
#include <string>

namespace studiohost {

class ObsFeed;
class ServerProcess;
class StudioDock;

// Ties everything together: runs the server, relays OBS events and requests between the
// server and OBS, manages the dock, the studio hub browser, built-in scenes and the
// global program-audio source.
class StudioController : public QObject {
	Q_OBJECT

public:
	StudioController();
	~StudioController() override;

private:
	static void handleFrontendEvent(enum obs_frontend_event event, void *data);
	void onFrontendEvent(enum obs_frontend_event event);
	void onServerMessage(const QByteArray &json);
	void onServerFailed(const QString &reason);

	void handleObsRequest(obs_data_t *msg);
	void reply(const char *id, bool ok, const std::string &text);
	void sendStatus(bool force = false);
	static void handleSourceListSignal(void *data, calldata_t *cd);
	obs_data_array_t *contentSourceNames();
	void setupScenesForCollectionOnce();
	void createScenesNow();
	void syncWidgets();
	void showDockFirstRun();
	void maybeAutoOpenWizard();

public:
	void openWizard();

private:
	void readSavedSettings();
	void loadPluginConfig();
	void savePluginConfig();
	void shutdown();

	ServerProcess *server = nullptr;
	ObsFeed *feed = nullptr;
	StudioDock *dock = nullptr;
	QDialog *wizard = nullptr;
	StudioDock *wizardView = nullptr;
	bool setupNeeded = false;
	obs_data_t *pluginConfig = nullptr;
	obs_data_array_t *widgets = nullptr; // the server's latest widget list
	bool obsLoaded = false;
	bool serverReady = false;
	bool everReady = false;
	bool shuttingDown = false;
	int slotCount = 4;
	int localPort = 8730;
	QByteArray lastStatus;
	QTimer *statusTimer = nullptr;
};

} // namespace studiohost
