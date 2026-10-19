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

#include "server-process.hpp"

#include <obs-module.h>
#include <plugin-support.h>
#include <util/bmem.h>

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QProcessEnvironment>
#include <QStandardPaths>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#endif

namespace studiohost {

namespace {

QString moduleFile(const char *relative)
{
	char *path = obs_module_file(relative); // nullptr when the file does not exist
	// OBS can return a path relative to its own working directory (on Windows,
	// "../../data/obs-plugins/..." from bin/64bit). The server runs from another directory,
	// so resolve it now.
	QString result = path ? QDir::cleanPath(QFileInfo(QString::fromUtf8(path)).absoluteFilePath()) : QString();
	bfree(path);
	return result;
}

} // namespace

ServerProcess::ServerProcess(QObject *parent) : QObject(parent)
{
	process = new QProcess(this);
	process->setProcessChannelMode(QProcess::SeparateChannels);
#ifdef _WIN32
	// Never flash a console window for the server.
	process->setCreateProcessArgumentsModifier(
		[](QProcess::CreateProcessArguments *args) { args->flags |= CREATE_NO_WINDOW; });
#endif
	connect(process, &QProcess::readyReadStandardOutput, this, &ServerProcess::onStdout);
	connect(process, &QProcess::readyReadStandardError, this, &ServerProcess::onStderr);
	connect(process, &QProcess::finished, this, &ServerProcess::onFinished);
	connect(process, &QProcess::errorOccurred, this, &ServerProcess::onError);

	restartTimer.setSingleShot(true);
	connect(&restartTimer, &QTimer::timeout, this, &ServerProcess::start);
}

ServerProcess::~ServerProcess()
{
	stop();
}

QString ServerProcess::dataDirectory()
{
	char *path = obs_module_config_path("");
	QString dir = QString::fromUtf8(path ? path : "");
	bfree(path);
	QDir().mkpath(dir);
	return QDir::cleanPath(dir);
}

QString ServerProcess::findNode(QString &why) const
{
	QString overridePath = qEnvironmentVariable("STUDIOHOST_NODE");
	if (!overridePath.isEmpty()) {
		if (QFileInfo::exists(overridePath))
			return overridePath;
		why = QStringLiteral("STUDIOHOST_NODE points to a missing file: ") + overridePath;
		return QString();
	}
#ifdef _WIN32
	QString bundled = moduleFile("node/node.exe");
#else
	QString bundled = moduleFile("node/node");
#endif
	if (!bundled.isEmpty()) {
		QFileInfo info(bundled);
		if (!info.isExecutable()) {
			// Packaging can drop the executable bit; restore it.
			QFile::setPermissions(bundled, QFile::permissions(bundled) | QFileDevice::ExeOwner |
							       QFileDevice::ExeGroup | QFileDevice::ExeOther);
		}
		return bundled;
	}
	QString onPath = QStandardPaths::findExecutable(QStringLiteral("node"));
	if (!onPath.isEmpty()) {
		obs_log(LOG_WARNING, "bundled Node.js runtime not found; using %s", onPath.toUtf8().constData());
		return onPath;
	}
	why = QStringLiteral("The bundled Node.js runtime is missing from the plugin. Reinstall Studio Host.");
	return QString();
}

void ServerProcess::start()
{
	if (isRunning())
		return;
	stopping = false;

	QString why;
	QString node = findNode(why);
	QString script = moduleFile("app/server/index.js");
	if (script.isEmpty())
		why = QStringLiteral(
			"The Studio Host server files are missing from the plugin. Reinstall Studio Host.");
	if (node.isEmpty() || script.isEmpty()) {
		obs_log(LOG_ERROR, "%s", why.toUtf8().constData());
		emit failed(why);
		return;
	}

	QString dataDir = dataDirectory();
	QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
	env.insert(QStringLiteral("STUDIOHOST_DATA"), dataDir);
	env.insert(QStringLiteral("STUDIOHOST_MANAGED"), QStringLiteral("1"));
	process->setProcessEnvironment(env);
	process->setWorkingDirectory(dataDir);
	process->setProgram(node);
	process->setArguments({script, QStringLiteral("--managed")});
	outBuffer.clear();
	errBuffer.clear();

	obs_log(LOG_INFO, "starting server: %s %s (data in %s)", node.toUtf8().constData(), script.toUtf8().constData(),
		dataDir.toUtf8().constData());
	process->start();
}

void ServerProcess::stop()
{
	restartTimer.stop();
	if (!process || process->state() == QProcess::NotRunning)
		return;
	stopping = true;
	// Closing stdin asks the server to exit cleanly.
	process->closeWriteChannel();
	// The server removes its router port mappings before exiting; give it a moment.
	if (!process->waitForFinished(5000)) {
		obs_log(LOG_WARNING, "server did not exit in time; terminating it");
		process->kill();
		process->waitForFinished(1000);
	}
}

void ServerProcess::restart()
{
	stop();
	recentCrashes = 0;
	start();
}

bool ServerProcess::isRunning() const
{
	return process && process->state() != QProcess::NotRunning;
}

void ServerProcess::send(const QByteArray &jsonLine)
{
	if (process->state() != QProcess::Running)
		return;
	process->write(jsonLine);
	process->write("\n");
}

bool ServerProcess::sendPacket(char kind, const QByteArray &payload, bool droppable)
{
	if (process->state() != QProcess::Running)
		return false;
	// Video frames are dropped rather than queued when the server is not keeping up.
	if (droppable && process->bytesToWrite() > 4 * 1024 * 1024)
		return false;
	// 0x01, kind, payload length (uint32 little-endian). JSON lines never start with 0x01.
	quint32 len = static_cast<quint32>(payload.size());
	char header[6] = {0x01,
			  kind,
			  static_cast<char>(len & 0xff),
			  static_cast<char>((len >> 8) & 0xff),
			  static_cast<char>((len >> 16) & 0xff),
			  static_cast<char>((len >> 24) & 0xff)};
	process->write(header, sizeof(header));
	process->write(payload);
	return true;
}

void ServerProcess::onStdout()
{
	outBuffer += process->readAllStandardOutput();
	qsizetype pos = 0;
	while (pos < outBuffer.size()) {
		if (outBuffer[pos] == 0x01) {
			// Binary packet: 0x01, kind, payload length (uint32 little-endian), payload.
			if (outBuffer.size() - pos < 6)
				break;
			auto *b = reinterpret_cast<const unsigned char *>(outBuffer.constData() + pos + 2);
			qsizetype len = b[0] | (b[1] << 8) | (b[2] << 16) | (static_cast<quint32>(b[3]) << 24);
			if (outBuffer.size() - pos < 6 + len)
				break;
			emit packetReceived(outBuffer[pos + 1], outBuffer.mid(pos + 6, len));
			pos += 6 + len;
		} else {
			qsizetype nl = outBuffer.indexOf('\n', pos);
			if (nl < 0)
				break;
			QByteArray line = outBuffer.mid(pos, nl - pos).trimmed();
			pos = nl + 1;
			if (!line.isEmpty())
				emit messageReceived(line);
		}
	}
	outBuffer.remove(0, pos);
}

void ServerProcess::onStderr()
{
	errBuffer += process->readAllStandardError();
	qsizetype nl;
	while ((nl = errBuffer.indexOf('\n')) >= 0) {
		QByteArray line = errBuffer.left(nl).trimmed();
		errBuffer.remove(0, nl + 1);
		if (!line.isEmpty())
			obs_log(LOG_INFO, "[server] %s", line.constData());
	}
}

void ServerProcess::onFinished(int exitCode, QProcess::ExitStatus status)
{
	if (stopping) {
		obs_log(LOG_INFO, "server stopped");
		emit stopped();
		return;
	}
	obs_log(LOG_WARNING, "server exited unexpectedly (code %d, %s)", exitCode,
		status == QProcess::CrashExit ? "crashed" : "exited");
	if (!crashWindow.isValid() || crashWindow.elapsed() > 60000) {
		crashWindow.start();
		recentCrashes = 0;
	}
	if (++recentCrashes > 5) {
		emit failed(
			QStringLiteral("The Studio Host server keeps stopping. Check the OBS log (Help → Log Files) "
				       "for details, then use Tools → Studio Host: Restart Server."));
		return;
	}
	restartTimer.start(2000);
}

void ServerProcess::onError(QProcess::ProcessError error)
{
	if (error == QProcess::FailedToStart) {
		QString reason = QStringLiteral("Could not start Node.js: ") + process->errorString();
		obs_log(LOG_ERROR, "%s", reason.toUtf8().constData());
		emit failed(reason);
	}
}

} // namespace studiohost
