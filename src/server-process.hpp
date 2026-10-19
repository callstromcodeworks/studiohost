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

#include <QObject>
#include <QProcess>
#include <QByteArray>
#include <QString>
#include <QTimer>
#include <QElapsedTimer>

namespace studiohost {

// Runs the Studio Host server (data/app/server/index.js) on the bundled Node.js runtime and
// exchanges line-delimited JSON with it over stdin/stdout, plus binary packets: the OBS feed on
// stdin, guest audio for the mixer strips on stdout. stderr is copied to the OBS log.
// The server exits on its own when stdin closes, so it never outlives OBS.
class ServerProcess : public QObject {
	Q_OBJECT

public:
	explicit ServerProcess(QObject *parent = nullptr);
	~ServerProcess() override;

	void start();
	void stop();
	void restart();
	bool isRunning() const;
	void send(const QByteArray &jsonLine);
	// Sends a binary packet (kind 'V' video, 'A' audio) to the server, interleaved with the
	// JSON lines on stdin. Returns false (dropping it) when the server is not running or,
	// for droppable packets, when it has fallen behind.
	bool sendPacket(char kind, const QByteArray &payload, bool droppable);

	// Folder holding config.json, state.json and uploads (inside the OBS plugin config folder).
	static QString dataDirectory();

signals:
	void messageReceived(const QByteArray &json);
	void packetReceived(char kind, const QByteArray &payload);
	void failed(const QString &reason); // could not start, or crashed repeatedly
	void stopped();

private slots:
	void onStdout();
	void onStderr();
	void onFinished(int exitCode, QProcess::ExitStatus status);
	void onError(QProcess::ProcessError error);

private:
	QString findNode(QString &why) const;

	QProcess *process = nullptr;
	QByteArray outBuffer;
	QByteArray errBuffer;
	bool stopping = false;
	int recentCrashes = 0;
	QElapsedTimer crashWindow;
	QTimer restartTimer;
};

} // namespace studiohost
