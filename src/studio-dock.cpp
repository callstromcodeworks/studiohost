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

#include "studio-dock.hpp"
#include "browser-panel.hpp"

#include <obs-module.h>
#include <plugin-support.h>

#include <QDesktopServices>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QUrl>
#include <QVBoxLayout>

namespace studiohost {

StudioDock::StudioDock(QWidget *parent) : QWidget(parent)
{
	setMinimumSize(300, 240);
	layout = new QVBoxLayout(this);
	layout->setContentsMargins(0, 0, 0, 0);

	statusPanel = new QWidget(this);
	auto *panelLayout = new QVBoxLayout(statusPanel);
	panelLayout->setContentsMargins(16, 16, 16, 16);
	statusLabel = new QLabel(statusPanel);
	statusLabel->setWordWrap(true);
	statusLabel->setAlignment(Qt::AlignCenter);
	statusLabel->setTextInteractionFlags(Qt::TextSelectableByMouse);

	restartButton = new QPushButton(QString::fromUtf8(obs_module_text("Dock.Restart")), statusPanel);
	folderButton = new QPushButton(QString::fromUtf8(obs_module_text("Dock.OpenFolder")), statusPanel);
	externalButton = new QPushButton(QString::fromUtf8(obs_module_text("Dock.OpenInBrowser")), statusPanel);
	connect(restartButton, &QPushButton::clicked, this, &StudioDock::restartRequested);
	connect(folderButton, &QPushButton::clicked, this, &StudioDock::openDataFolderRequested);
	connect(externalButton, &QPushButton::clicked, this, [this]() {
		if (!url.isEmpty())
			QDesktopServices::openUrl(QUrl(url));
	});

	auto *buttons = new QHBoxLayout();
	buttons->addStretch(1);
	buttons->addWidget(externalButton);
	buttons->addWidget(restartButton);
	buttons->addWidget(folderButton);
	buttons->addStretch(1);

	panelLayout->addStretch(1);
	panelLayout->addWidget(statusLabel);
	panelLayout->addLayout(buttons);
	panelLayout->addStretch(1);
	layout->addWidget(statusPanel);

	initTimer.setInterval(250);
	connect(&initTimer, &QTimer::timeout, this, &StudioDock::tryCreateBrowser);

	showStatus(QString::fromUtf8(obs_module_text("Dock.Starting")));
}

StudioDock::~StudioDock()
{
	shutdown();
}

void StudioDock::showStatus(const QString &text, bool error)
{
	statusLabel->setText(text);
	restartButton->setVisible(error);
	folderButton->setVisible(error);
	externalButton->setVisible(false);
	statusPanel->show();
	if (browser)
		browser->hide();
}

void StudioDock::showPage(const QString &pageUrl)
{
	bool changed = pageUrl != url;
	url = pageUrl;
	if (browser) {
		if (changed)
			browser->setURL(url.toStdString());
		else
			browser->reloadPage();
		statusPanel->hide();
		browser->show();
		return;
	}
	initAttempts = 0;
	tryCreateBrowser();
}

void StudioDock::tryCreateBrowser()
{
	if (browser || url.isEmpty()) {
		initTimer.stop();
		return;
	}
	if (!cef) {
		cef = obs_browser_init_panel();
		if (!cef) {
			initTimer.stop();
			showStatus(QString::fromUtf8(obs_module_text("Dock.NoBrowser")));
			externalButton->setVisible(true);
			return;
		}
		cef->init_browser();
	}
	if (!cef->initialized()) {
		// The embedded browser starts asynchronously; poll instead of blocking the UI.
		if (++initAttempts > 240) {
			initTimer.stop();
			showStatus(QString::fromUtf8(obs_module_text("Dock.NoBrowser")));
			externalButton->setVisible(true);
		} else if (!initTimer.isActive()) {
			initTimer.start();
		}
		return;
	}
	initTimer.stop();
	if (!cookies)
		cookies = cef->create_cookie_manager("studiohost_dock", true);
	browser = cef->create_widget(this, url.toStdString(), cookies);
	if (!browser) {
		showStatus(QString::fromUtf8(obs_module_text("Dock.NoBrowser")));
		externalButton->setVisible(true);
		return;
	}
	layout->addWidget(browser, 1);
	statusPanel->hide();
	browser->show();
}

void StudioDock::shutdown()
{
	initTimer.stop();
	if (browser) {
		browser->closeBrowser();
		delete browser;
		browser = nullptr;
	}
	if (cookies) {
		cookies->FlushStore();
		delete cookies;
		cookies = nullptr;
	}
	// The QCef handle is deliberately not deleted: this runs while OBS is shutting the
	// browser down, and leaking one small handle at exit is harmless.
	cef = nullptr;
}

} // namespace studiohost
