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

#include "studio-controller.hpp"
#include "obs-feed.hpp"
#include "server-process.hpp"
#include "studio-dock.hpp"
#include "studio-scenes.hpp"
#include "studio-sources.hpp"

#include <obs-module.h>
#include <plugin-support.h>
#include <util/bmem.h>

#include <QDesktopServices>
#include <QDir>
#include <QDockWidget>
#include <QMainWindow>
#include <QDialog>
#include <QMessageBox>
#include <QVBoxLayout>
#include <QTimer>
#include <QUrl>

#include <cstring>

namespace studiohost {

namespace {

const char *const DOCK_ID = "studiohost";

QString text(const char *key)
{
	return QString::fromUtf8(obs_module_text(key));
}

std::string currentCollection()
{
	char *name = obs_frontend_get_current_scene_collection();
	std::string result = name ? name : "";
	bfree(name);
	return result;
}

std::string sceneName(obs_source_t *scene)
{
	const char *name = scene ? obs_source_get_name(scene) : nullptr;
	return name ? name : "";
}

} // namespace

StudioController::StudioController()
{
	loadPluginConfig();
	readSavedSettings();

	dock = new StudioDock();
	if (!obs_frontend_add_dock_by_id(DOCK_ID, obs_module_text("Dock.Title"), dock))
		obs_log(LOG_WARNING, "could not add the Studio Host dock");
	connect(dock, &StudioDock::restartRequested, this, &StudioController::restartServer);
	connect(dock, &StudioDock::openDataFolderRequested, this,
		[]() { QDesktopServices::openUrl(QUrl::fromLocalFile(ServerProcess::dataDirectory())); });

	server = new ServerProcess(this);
	connect(server, &ServerProcess::messageReceived, this, &StudioController::onServerMessage);
	connect(server, &ServerProcess::failed, this, &StudioController::onServerFailed);
	feed = new ObsFeed(server, this);

	obs_frontend_add_event_callback(handleFrontendEvent, this);

	// Keep the dock's list of OBS sources (for content) current. Sources are created and
	// removed on any thread, often in bursts, so coalesce into one status update.
	statusTimer = new QTimer(this);
	statusTimer->setSingleShot(true);
	statusTimer->setInterval(300);
	connect(statusTimer, &QTimer::timeout, this, [this]() { sendStatus(); });
	signal_handler_t *sh = obs_get_signal_handler();
	signal_handler_connect(sh, "source_create", handleSourceListSignal, this);
	signal_handler_connect(sh, "source_destroy", handleSourceListSignal, this);
	signal_handler_connect(sh, "source_rename", handleSourceListSignal, this);

	obs_frontend_add_tools_menu_item(
		obs_module_text("Menu.Wizard"), [](void *data) { static_cast<StudioController *>(data)->openWizard(); },
		this);
	obs_frontend_add_tools_menu_item(
		obs_module_text("Menu.CreateScenes"),
		[](void *data) { static_cast<StudioController *>(data)->createScenesNow(); }, this);
	obs_frontend_add_tools_menu_item(
		obs_module_text("Menu.Restart"),
		[](void *data) { static_cast<StudioController *>(data)->restartServer(); }, this);
	obs_frontend_add_tools_menu_item(
		obs_module_text("Menu.OpenFolder"),
		[](void *) { QDesktopServices::openUrl(QUrl::fromLocalFile(ServerProcess::dataDirectory())); }, this);

	// With STUDIOHOST_DEBUG=1, log a heartbeat from the UI thread (helps diagnose stalls).
	if (qEnvironmentVariable("STUDIOHOST_DEBUG") == QStringLiteral("1")) {
		auto *heartbeat = new QTimer(this);
		connect(heartbeat, &QTimer::timeout, this,
			[this]() { obs_log(LOG_INFO, "heartbeat (server %s)", serverReady ? "ready" : "not ready"); });
		heartbeat->start(5000);
	}

	// Start early: guests and pages can connect as soon as the server is up.
	server->start();
}

StudioController::~StudioController()
{
	shutdown();
	obs_frontend_remove_event_callback(handleFrontendEvent, this);
	obs_data_release(pluginConfig);
	obs_data_array_release(widgets);
}

void StudioController::handleSourceListSignal(void *data, calldata_t *)
{
	auto *self = static_cast<StudioController *>(data);
	if (self->shuttingDown)
		return;
	QMetaObject::invokeMethod(self->statusTimer, "start", Qt::QueuedConnection);
}

void StudioController::shutdown()
{
	if (shuttingDown)
		return;
	shuttingDown = true;
	signal_handler_t *sh = obs_get_signal_handler();
	signal_handler_disconnect(sh, "source_create", handleSourceListSignal, this);
	signal_handler_disconnect(sh, "source_destroy", handleSourceListSignal, this);
	signal_handler_disconnect(sh, "source_rename", handleSourceListSignal, this);
	clear_program_content();
	if (feed)
		feed->setEnabled(false);
	if (wizardView)
		wizardView->shutdown();
	if (dock)
		dock->shutdown();
	stop_program_browser();
	detach_global_audio();
	if (server)
		server->stop();
}

void StudioController::restartServer()
{
	dock->showStatus(text("Dock.Starting"));
	server->restart();
}

// ---- settings -------------------------------------------------------------------

void StudioController::readSavedSettings()
{
	QString dir = ServerProcess::dataDirectory();
	obs_data_t *config = obs_data_create_from_json_file((dir + "/config.json").toUtf8().constData());
	if (config) {
		long long port = obs_data_get_int(config, "localPort");
		if (port > 0 && port < 65536)
			localPort = static_cast<int>(port);
		obs_data_release(config);
	}
	obs_data_t *state = obs_data_create_from_json_file((dir + "/state.json").toUtf8().constData());
	if (state) {
		long long n = obs_data_get_int(state, "slots");
		if (n >= 1 && n <= 16)
			slotCount = static_cast<int>(n);
		obs_data_release(state);
	}
}

void StudioController::loadPluginConfig()
{
	QString path = ServerProcess::dataDirectory() + "/plugin.json";
	pluginConfig = obs_data_create_from_json_file(path.toUtf8().constData());
	if (!pluginConfig)
		pluginConfig = obs_data_create();
}

void StudioController::savePluginConfig()
{
	QString path = ServerProcess::dataDirectory() + "/plugin.json";
	obs_data_save_json_safe(pluginConfig, path.toUtf8().constData(), "tmp", "bak");
}

// ---- frontend events -------------------------------------------------------------

void StudioController::handleFrontendEvent(enum obs_frontend_event event, void *data)
{
	static_cast<StudioController *>(data)->onFrontendEvent(event);
}

void StudioController::onFrontendEvent(enum obs_frontend_event event)
{
	switch (event) {
	case OBS_FRONTEND_EVENT_FINISHED_LOADING:
		obsLoaded = true;
		attach_global_audio();
		if (serverReady)
			start_program_browser();
		rename_legacy_builtins();
		setupScenesForCollectionOnce();
		syncWidgets();
		showDockFirstRun();
		maybeAutoOpenWizard();
		sendStatus(true);
		break;
	case OBS_FRONTEND_EVENT_SCENE_COLLECTION_CLEANUP:
		detach_global_audio();
		break;
	case OBS_FRONTEND_EVENT_SCENE_COLLECTION_CHANGED:
		if (!obsLoaded)
			break;
		attach_global_audio();
		rename_legacy_builtins();
		setupScenesForCollectionOnce();
		syncWidgets();
		sendStatus();
		break;
	case OBS_FRONTEND_EVENT_SCENE_CHANGED:
	case OBS_FRONTEND_EVENT_PREVIEW_SCENE_CHANGED:
	case OBS_FRONTEND_EVENT_STUDIO_MODE_ENABLED:
	case OBS_FRONTEND_EVENT_STUDIO_MODE_DISABLED:
	case OBS_FRONTEND_EVENT_STREAMING_STARTED:
	case OBS_FRONTEND_EVENT_STREAMING_STOPPED:
	case OBS_FRONTEND_EVENT_RECORDING_STARTED:
	case OBS_FRONTEND_EVENT_RECORDING_STOPPED:
	case OBS_FRONTEND_EVENT_VIRTUALCAM_STARTED:
	case OBS_FRONTEND_EVENT_VIRTUALCAM_STOPPED:
		sendStatus();
		break;
	case OBS_FRONTEND_EVENT_EXIT:
		shutdown();
		break;
	default:
		break;
	}
}

// ---- server messages --------------------------------------------------------------

void StudioController::onServerMessage(const QByteArray &json)
{
	obs_data_t *msg = obs_data_create_from_json(json.constData());
	if (!msg) {
		obs_log(LOG_WARNING, "ignoring malformed message from server");
		return;
	}
	const char *type = obs_data_get_string(msg, "type");

	if (strcmp(type, "ready") == 0) {
		bool restarted = everReady;
		serverReady = true;
		feed->setEnabled(false); // a new server asks again when it needs the feed
		everReady = true;
		long long port = obs_data_get_int(msg, "localPort");
		if (port > 0 && port < 65536)
			localPort = static_cast<int>(port);
		long long n = obs_data_get_int(msg, "slots");
		if (n >= 1 && n <= 16)
			slotCount = static_cast<int>(n);
		std::string base = "http://127.0.0.1:" + std::to_string(localPort);
		set_base_url(base); // points every page at the server (no-op if unchanged)
		if (obsLoaded)
			start_program_browser();
		// After a restart on the same port, pages may be showing a browser error page.
		if (restarted)
			reload_all_pages();
		dock->showPage(QString::fromStdString(base + "/host/"));
		setupNeeded = !obs_data_get_bool(msg, "configured");
		sendStatus(true);
		obs_log(LOG_INFO, "server ready on port %d%s", localPort, setupNeeded ? " (setup needed)" : "");
		maybeAutoOpenWizard();
		if (wizard && wizard->isVisible())
			wizardView->showPage(QString::fromStdString(base + "/setup/"));
	} else if (strcmp(type, "obs") == 0) {
		handleObsRequest(msg);
	} else if (strcmp(type, "feed") == 0) {
		feed->setEnabled(obs_data_get_bool(msg, "on"));
	} else if (strcmp(type, "open-wizard") == 0) {
		openWizard();
	} else if (strcmp(type, "setup-done") == 0) {
		if (wizard)
			wizard->hide();
	} else if (strcmp(type, "network") == 0) {
		setupNeeded = !obs_data_get_bool(msg, "configured");
	} else if (strcmp(type, "content") == 0) {
		obs_data_t *rect = obs_data_get_obj(msg, "rect");
		set_program_content(obs_data_get_string(msg, "source"), rect != nullptr,
				    (float)obs_data_get_double(rect, "x"), (float)obs_data_get_double(rect, "y"),
				    (float)obs_data_get_double(rect, "w"), (float)obs_data_get_double(rect, "h"));
		obs_data_release(rect);
	} else if (strcmp(type, "widgets") == 0) {
		obs_data_array_release(widgets);
		widgets = obs_data_get_array(msg, "items");
		syncWidgets();
	} else if (strcmp(type, "slots") == 0) {
		long long n = obs_data_get_int(msg, "count");
		if (n >= 1 && n <= 16) {
			slotCount = static_cast<int>(n);
			// Collections that use the built-in scenes get scenes for the new slots too.
			if (obsLoaded && scenesCreated(currentCollection()))
				ensure_builtin_scenes(slotCount);
		}
	} else if (strcmp(type, "restart") == 0) {
		serverReady = false;
		dock->showStatus(text("Dock.Restarting"));
		// Restart after this message handler returns.
		QMetaObject::invokeMethod(this, [this]() { server->restart(); }, Qt::QueuedConnection);
	} else if (strcmp(type, "fatal") == 0) {
		dock->showStatus(QString::fromUtf8(obs_data_get_string(msg, "message")), true);
	}
	obs_data_release(msg);
}

void StudioController::onServerFailed(const QString &reason)
{
	serverReady = false;
	dock->showStatus(reason, true);
}

void StudioController::handleObsRequest(obs_data_t *msg)
{
	const char *id = obs_data_get_string(msg, "id");
	const char *action = obs_data_get_string(msg, "action");
	if (!obsLoaded) {
		reply(id, false, "OBS is still loading. Try again in a moment.");
		return;
	}
	if (strcmp(action, "setScene") == 0) {
		std::string error;
		const char *scene = obs_data_get_string(msg, "scene");
		int slot = static_cast<int>(obs_data_get_int(msg, "slot"));
		bool ok = switch_to_builtin_scene(scene, slot, error);
		reply(id, ok, ok ? "Switched scene." : error);
	} else if (strcmp(action, "setupScenes") == 0) {
		std::string summary = ensure_builtin_scenes(slotCount);
		markScenesCreated(currentCollection());
		syncWidgets();
		reply(id, true, summary);
	} else {
		reply(id, false, "Unknown request.");
	}
}

void StudioController::reply(const char *id, bool ok, const std::string &message)
{
	obs_data_t *r = obs_data_create();
	obs_data_set_string(r, "type", "obs-result");
	obs_data_set_string(r, "id", id);
	obs_data_set_bool(r, "ok", ok);
	obs_data_set_string(r, ok ? "message" : "error", message.c_str());
	server->send(QByteArray(obs_data_get_json(r)));
	obs_data_release(r);
}

void StudioController::sendStatus(bool force)
{
	if (!serverReady || !obsLoaded)
		return;
	bool studioMode = obs_frontend_preview_program_mode_active();
	obs_source_t *program = obs_frontend_get_current_scene();
	obs_source_t *preview = studioMode ? obs_frontend_get_current_preview_scene() : nullptr;
	std::string programName = sceneName(program);
	// In Studio Mode the dock's scene buttons change the preview, so highlight that one.
	std::string target = studioMode ? sceneName(preview) : programName;
	obs_source_release(program);
	obs_source_release(preview);

	obs_data_t *s = obs_data_create();
	obs_data_set_string(s, "type", "obs-status");
	obs_data_set_bool(s, "streaming", obs_frontend_streaming_active());
	obs_data_set_bool(s, "recording", obs_frontend_recording_active());
	obs_data_set_bool(s, "virtualcam", obs_frontend_virtualcam_active());
	obs_data_set_bool(s, "studioMode", studioMode);
	obs_data_set_string(s, "scene", programName.c_str());
	obs_data_set_string(s, "builtin", builtin_id_for_scene(target.c_str()).c_str());
	obs_data_array_t *sources = contentSourceNames();
	obs_data_set_array(s, "sources", sources);
	obs_data_array_release(sources);
	QByteArray line(obs_data_get_json(s));
	obs_data_release(s);
	if (!force && line == lastStatus)
		return;
	lastStatus = line;
	server->send(line);
}

// Names of the OBS sources the producer can show as content: scenes, then video inputs,
// leaving out Studio Host's own sources and scenes (which would show the studio inside itself).
obs_data_array_t *StudioController::contentSourceNames()
{
	obs_data_array_t *list = obs_data_array_create();
	auto add = [list](const char *name) {
		obs_data_t *item = obs_data_create();
		obs_data_set_string(item, "name", name);
		obs_data_array_push_back(list, item);
		obs_data_release(item);
	};
	obs_frontend_source_list scenes = {};
	obs_frontend_get_scenes(&scenes);
	for (size_t i = 0; i < scenes.sources.num; i++) {
		const char *name = obs_source_get_name(scenes.sources.array[i]);
		if (name && builtin_id_for_scene(name).empty())
			add(name);
	}
	obs_frontend_source_list_free(&scenes);
	obs_enum_sources(
		[](void *param, obs_source_t *src) {
			auto *addName = static_cast<decltype(add) *>(param);
			const char *id = obs_source_get_unversioned_id(src);
			const char *name = obs_source_get_name(src);
			if (name && *name && (obs_source_get_output_flags(src) & OBS_SOURCE_VIDEO) &&
			    strncmp(id, "studiohost_", 11) != 0)
				(*addName)(name);
			return true;
		},
		&add);
	return list;
}

// ---- setup wizard -------------------------------------------------------------------

// Opens the wizard by itself once: on the first launch, when guests can't join yet.
void StudioController::maybeAutoOpenWizard()
{
	if (!obsLoaded || !serverReady || !setupNeeded || obs_data_get_bool(pluginConfig, "wizardShown"))
		return;
	obs_data_set_bool(pluginConfig, "wizardShown", true);
	savePluginConfig();
	obs_log(LOG_INFO, "opening the setup wizard (first run)");
	openWizard();
}

void StudioController::openWizard()
{
	if (!serverReady) {
		QMessageBox::information(static_cast<QWidget *>(obs_frontend_get_main_window()), text("Wizard.Title"),
					 text("Dock.Starting"));
		return;
	}
	if (!wizard) {
		wizard = new QDialog(static_cast<QWidget *>(obs_frontend_get_main_window()));
		wizard->setWindowTitle(text("Wizard.Title"));
		wizard->resize(780, 860);
		auto *layout = new QVBoxLayout(wizard);
		layout->setContentsMargins(0, 0, 0, 0);
		wizardView = new StudioDock(wizard);
		layout->addWidget(wizardView);
	}
	wizardView->showPage(QString::fromStdString("http://127.0.0.1:" + std::to_string(localPort) + "/setup/"));
	wizard->show();
	wizard->raise();
	wizard->activateWindow();
	obs_log(LOG_INFO, "setup wizard shown (visible: %s)", wizard->isVisible() ? "yes" : "no");
}

// ---- scenes and dock --------------------------------------------------------------

void StudioController::setupScenesForCollectionOnce()
{
	std::string collection = currentCollection();
	if (collection.empty())
		return;
	if (scenesCreated(collection))
		return;
	std::string summary = ensure_builtin_scenes(slotCount);
	obs_log(LOG_INFO, "scene collection '%s': %s", collection.c_str(), summary.c_str());
	markScenesCreated(collection);
}

// Whether the built-in scenes were created for `collection` (they are only created once, so
// scenes the producer deletes stay deleted).
bool StudioController::scenesCreated(const std::string &collection)
{
	obs_data_t *done = obs_data_get_obj(pluginConfig, "scenesCreated");
	bool created = done && obs_data_has_user_value(done, collection.c_str());
	obs_data_release(done);
	return created;
}

void StudioController::markScenesCreated(const std::string &collection)
{
	obs_data_t *done = obs_data_get_obj(pluginConfig, "scenesCreated");
	if (!done) {
		done = obs_data_create();
		obs_data_set_obj(pluginConfig, "scenesCreated", done);
	}
	obs_data_set_bool(done, collection.c_str(), true);
	obs_data_release(done);
	savePluginConfig();
}

void StudioController::createScenesNow()
{
	std::string summary = ensure_builtin_scenes(slotCount);
	markScenesCreated(currentCollection());
	syncWidgets();
	QMessageBox::information(static_cast<QWidget *>(obs_frontend_get_main_window()), text("Dock.Title"),
				 QString::fromStdString(summary));
}

// Brings the widget Browser Sources in the Studio scene in line with the server's list. Runs
// once OBS has loaded, whenever the list changes, and for each scene collection.
void StudioController::syncWidgets()
{
	if (!obsLoaded || !widgets)
		return;
	sync_widgets(widgets);
}

void StudioController::showDockFirstRun()
{
	if (obs_data_get_bool(pluginConfig, "dockShown"))
		return;
	if (auto *dockWidget = qobject_cast<QDockWidget *>(dock->parentWidget())) {
		dockWidget->setFloating(false);
		dockWidget->setVisible(true);
	}
	obs_data_set_bool(pluginConfig, "dockShown", true);
	savePluginConfig();
}

} // namespace studiohost
