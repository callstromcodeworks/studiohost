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

#include <QWidget>
#include <QString>
#include <QTimer>

class QLabel;
class QPushButton;
class QVBoxLayout;
class QCefWidget;
struct QCef;
struct QCefCookieManager;

namespace studiohost {

// The "Studio Host" dock: the producer controls page in OBS's embedded browser, with a
// native status panel while the server is starting or if something goes wrong.
class StudioDock : public QWidget {
	Q_OBJECT

public:
	explicit StudioDock(QWidget *parent = nullptr);
	~StudioDock() override;

	// Shows the producer page (creating the embedded browser on first use).
	void showPage(const QString &url);
	// Shows a status message instead of the page. Error messages offer recovery buttons.
	void showStatus(const QString &text, bool error = false);
	// Closes the embedded browser; call before OBS shuts the browser down.
	void shutdown();

signals:
	void restartRequested();
	void openDataFolderRequested();

private:
	void tryCreateBrowser();

	QVBoxLayout *layout = nullptr;
	QWidget *statusPanel = nullptr;
	QLabel *statusLabel = nullptr;
	QPushButton *restartButton = nullptr;
	QPushButton *folderButton = nullptr;
	QPushButton *externalButton = nullptr;
	QCef *cef = nullptr;
	QCefCookieManager *cookies = nullptr;
	QCefWidget *browser = nullptr;
	QString url;
	QTimer initTimer;
	int initAttempts = 0;
};

} // namespace studiohost
