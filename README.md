# Studio Host

A remote guest studio built into OBS. Guests join from a browser link with no installs. You produce the show from an OBS dock. OBS gets finished, branded video and audio through its own sources and scenes, and does the streaming and recording itself.

By Callstrom Code Works.

> **Status: v0.2, early.** CI builds the plugin for Windows, macOS and Linux. On Linux, CI also installs it into a real OBS (under a virtual display, with browser hardware acceleration off) and checks the whole path: the plugin starts the server and creates the scenes and sources; four guests join on simulated uplinks from 100 kbps to uncapped; their video and audio reach the studio within each cap; program audio reaches the OBS mixer; and every layout — with guests hidden, with an OBS source as content, and with a guest's screen share as content — is checked pixel by pixel in OBS's own rendered frame. It has not yet been tried by hand on Windows or macOS, or with browser hardware acceleration on — please report what you find.

## What you get in OBS

- **Studio Host dock** (Docks menu): the producer controls — backstage and stage, layouts, banners, branding, media, private chat, scene buttons, and connection settings.
- **Sources** (Add Source menu):
  - **Studio Host Program** — the composited stage: layouts, name tags, banners, ticker, logo, background, overlay and video clips.
  - **Studio Host Guest** — one guest slot (camera or screen share), with options for name tag, fit, showing while backstage, and the guest's own audio for a separate track.
  - **Studio Host Guest Screen Share** — the screen a guest is sharing (the featured one), full frame.
- **Built-in scenes**, created once per scene collection (missing ones can be recreated from the dock or Tools menu; existing ones are never changed):
  - *Studio Host: Studio*, *Studio Host: Guest Screen Share*, *Studio Host: Guest 1…N*
- **Studio Host Audio** in the mixer: the program audio (everyone on stage, plus clips) stays live whichever scene is showing.
- **Tools menu**: Create Built-in Scenes, Restart Server, Open Data Folder.

Features of the studio itself: guest green room (device check, level meter), backstage/on-stage, hiding guests from the picture, layouts with and without content (below), guest screen sharing, branding, banners and tickers, video clips, per-guest volume/mute/talkback, a mix-minus return feed so every guest sees and hears the show, and private producer–guest chat. Not included on purpose: multistreaming, recording, audience comments, webinars and video repurposing — OBS or other tools handle those.

## How it works

```
OBS
 ├─ Studio Host plugin (C++)
 │    ├─ starts the Studio Host server (bundled Node.js) and talks to it over stdin/stdout
 │    ├─ provides the sources, built-in scenes, dock and Tools menu
 │    └─ keeps a hidden "studio hub" browser running: it composites the stage, mixes the
 │       program audio, and sends each guest the OBS output plus a mix-minus
 └─ Studio Host server (Node.js, no dependencies)
      ├─ serves the guest, producer and output pages; relays WebRTC signaling
      └─ stores branding, banners and uploaded media

Guest browser ──HTTPS invite link──▶ server
Guest browser ──WebRTC audio/video──▶ studio hub, guest/screen sources, dock previews
```

While guests are connected, the plugin also sends the studio hub what OBS is outputting, so guests see and hear the actual show: the program picture (scaled to 960 pixels wide) and the audio of mixer **track 6**. Studio Host takes its own guest audio off track 6 so guests don't hear themselves; leave Studio Host Audio and guest sources off that track (Edit → Advanced Audio Properties). Everything else on track 6, such as your microphone and desktop audio, reaches the guests.

Media goes browser-to-browser over WebRTC; it never passes through the server. The studio pages inside OBS keep running (and keep their guests connected) even when their sources aren't on screen, so switching scenes is instant; that costs some CPU while Studio Host is loaded.

## Install

You need **OBS Studio 31 or newer**, installed from obsproject.com (or, on Ubuntu, the official OBS PPA), with its built-in Browser plugin. Node.js is bundled; nothing else needs installing.

Download the file for your system from the [latest release](https://github.com/callstromcodeworks/studiohost/releases/tag/latest), which is rebuilt from every change to `main`. Close OBS before installing.

### Windows

1. Download `studiohost-<version>-windows-x64.zip`.
2. Open your OBS program folder, the one that contains `bin`, `data` and `obs-plugins`. It's usually `C:\Program Files\obs-studio`.
3. Extract the zip into that folder, merging with the folders already there. Windows asks for administrator permission. Afterwards you should have:
   - `obs-plugins\64bit\studiohost.dll`
   - `data\obs-plugins\studiohost\` (with `locale`, `app` and `node` inside)

To update, close OBS and extract the new zip the same way, replacing files when asked. To uninstall, delete `obs-plugins\64bit\studiohost.dll`, `obs-plugins\64bit\studiohost.pdb` and the `data\obs-plugins\studiohost` folder.

If the Tools menu shows names like `Menu.Wizard` instead of "Studio Host: Setup Wizard", OBS found the plugin but not its `data` folder: check that it's at `data\obs-plugins\studiohost`.

### macOS (12 or newer, Apple Silicon or Intel)

1. Download `studiohost-<version>-macos-universal.pkg` and double-click it.
2. The installer isn't signed yet, so macOS blocks it the first time. Open **System Settings → Privacy & Security**, scroll down to the message about `studiohost`, click **Open Anyway**, and run the installer again.
3. Choose **Install for me only** if asked. It installs to `~/Library/Application Support/obs-studio/plugins/studiohost.plugin`.

To update, run the new installer. To uninstall, delete `~/Library/Application Support/obs-studio/plugins/studiohost.plugin` (in Finder: **Go → Go to Folder…** and paste `~/Library/Application Support/obs-studio/plugins`).

### Linux (Ubuntu 24.04 or newer)

The `.deb` is for the OBS installed from Ubuntu packages. It doesn't work with the Flatpak or Snap versions of OBS. Ubuntu's own OBS package is older than 31, so install OBS from the official PPA first:

```sh
sudo add-apt-repository ppa:obsproject/obs-studio
sudo apt update && sudo apt install obs-studio
```

Then download `studiohost-<version>-x86_64-linux-gnu.deb` and install it:

```sh
sudo apt install ./studiohost-*-x86_64-linux-gnu.deb
```

To update, install the new `.deb` the same way. To uninstall, run `sudo apt remove studiohost`.

### Check it worked

Start OBS. On first launch Studio Host starts its server, opens the setup wizard, and creates the built-in scenes (**Studio Host: Studio**, **Studio Host: Guest Screen Share**, and one per guest slot) in the current scene collection. The **Studio Host** dock is under the **Docks** menu. If none of this appears, open **Help → Log Files → View Current Log** and search for `studiohost`.

## Layouts and content

The picture uses one of two layout families. Which one applies depends on what you choose in the **Content** picker (below): with no content, the guests-only layout is used; once you pick a screen share or an OBS source, the with-content layout is used.

- **Guests only** — Solo, Group, Leader, Side by side. Used while no content is showing; the guests fill the frame.
- **With content** — Guests on sides (content centered, guests split into a column on each side), Guests right, Picture-in-picture (slot 1 in the top-left corner, the other guests stacked down the right edge, content in the middle), Content only. Used while content is showing.

Pick one layout from each row in the dock; whichever applies is marked "in use".

**Content** (the picker above the layouts) is either a guest's **screen share** or any **OBS source or scene** — a display capture of your own screen, a game capture, a media file, another camera. Choosing None returns to the guests-only layout, as does the sharing guest stopping their screen share. An OBS source is drawn by the plugin inside the Studio Host Program source, beneath the studio picture, so banners and the logo still sit on top of it. Guests can't see OBS sources, so their return feed shows a labeled placeholder in that spot. Studio Host's own sources and scenes aren't offered, and a scene that contains the Program source is refused (it would draw itself).

**Hide** (on an on-stage guest's card) takes a guest out of the picture without taking them off stage: their audio stays in the program, the layout re-flows for the guests still shown, and their Guest slot source hides too. **Remove** sends them backstage (no picture, no program audio).

## Alerts and widgets

Donation, follower and subscriber alerts, goal bars and event lists from Streamlabs, StreamElements and similar services are web pages made to run in an OBS Browser Source. Add one in the dock under **Media → Alerts & widgets**: give it a name and paste its widget link. Studio Host adds it as a Browser Source called *Studio Host Widget: <name>* on top of the *Studio Host: Studio* scene, at the full canvas size, with **Control audio via OBS** on so alert sounds show up in the mixer. **Show**/**Hide** in the dock turn it on and off; deleting it there removes the source from OBS. You can move, crop or resize it in OBS like any other source, and it shows in the guests' return feed because it's part of the OBS output.

Widget links contain your account token, so treat them like passwords. Studio Host keeps them in `state.json` and sends them only to OBS, never to guest or producer pages. Widgets need the OBS plugin.

## Guest connection quality

Each connected guest's card shows what the studio is receiving from them — resolution, video bitrate and audio bitrate — and flags video under about 250 kbps. A guest link can cap what that guest sends by adding `&maxv=<kbps>&maxa=<kbps>`, for example for a guest on a metered connection: `…/guest/?k=…&maxv=600&maxa=24`.

## Setup: how guests reach you

The **setup wizard** opens by itself the first time Studio Host runs, and again any time from **Tools → Studio Host: Setup Wizard** or the dock's Setup tab. Guests can't join until it's done. It offers two methods.

### Automatic (recommended)

Nothing to configure. Studio Host:

1. picks a random 5-digit port and opens it on your router with **UPnP** (or **NAT-PMP** on routers that use it), renewing it while it runs and removing it when OBS closes;
2. gets its own web address from the **Studio Host hostname service**, a random name such as `amber-otter-4821.studiohost.callstromcodeworks.com`. The name is kept as long as Studio Host runs at least once every 90 days, and it follows your IP when it changes;
3. gets a free **Let's Encrypt** certificate for that name (renewed automatically), so guests see no security warning;
4. tests from the internet that guests can actually reach your studio.

The wizard shows each stage as it completes, with the reason and a fix when one fails. Automatic setup needs a router with UPnP or NAT-PMP turned on, and a public IP address: it can't work behind carrier-grade NAT (some mobile and fiber providers), and the wizard says so if that's the case.

### Manual (advanced users)

For when you manage the network yourself:

- **Address:** your own domain or public IP, or **this local network only** (for testing or an in-building show).
- **Guest port** and **listen address**, and optionally opening the port with UPnP.
- **Certificate:** Let's Encrypt for your domain (Let's Encrypt checks it on port 80, so forward port 80 to this computer, or to a local port you enter); your own certificate files (PEM); or self-signed (every guest sees a browser warning first).
- **Max guests**: how many people can be in the studio at once (10 by default). Anyone past that is told the studio is full.
- **STUN/TURN servers**. Add a TURN server, such as [coturn](https://github.com/coturn/coturn), if guests on strict networks get stuck connecting:

  ```json
  [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": ["turn:studio.example.com:3478?transport=udp", "turn:studio.example.com:3478?transport=tcp"], "username": "studio", "credential": "your-secret" }
  ]
  ```

### Inviting guests

Copy the **Invite link** from the dock's top bar or Setup tab and send it however you like. One link works for every guest; each types their name in the green room. To appear on camera yourself, open **Join on camera yourself** (Setup tab) in a normal browser. If your own mic is already an OBS input, mark yourself **Talkback only** so your voice isn't doubled in the program.

Media (audio and video) still travels peer-to-peer between each guest's browser and this computer over WebRTC, separately from the guest port. That works on most home networks; a TURN server covers the rest.

## Data and security

Settings, branding, banners and uploads live in the plugin's config folder (Tools → Studio Host: Open Data Folder): `config.json` (including your setup and, in Automatic mode, your hostname and its token), `state.json`, `uploads/`, and `tls/` (certificates and the Let's Encrypt account key).

- Pages loaded from `127.0.0.1` on the local port are trusted — that is how OBS connects without a key. The guest port never trusts anyone without a key.
- The invite link only lets someone into the backstage area; only producers can put people on stage.
- Setup and connection settings can only be viewed and changed from the OBS computer.
- Anyone with the host key (in "Producer controls from another device") can control the studio. To revoke links, change `guestKey` / `hostKey` in `config.json` and restart the server.

## Troubleshooting

- **Dock says the server keeps stopping** — check the OBS log (Help → Log Files); lines from the server start with `[server]`. The local port (8730) being taken by another program is the most common cause: change `localPort` in `config.json` (Open Data Folder) and restart.
- **Automatic setup can't open the port** — turn on UPnP (sometimes "UPnP IGD") or NAT-PMP in your router's settings and choose Try again, or use Manual setup and forward the port yourself.
- **"Your router has no public internet address"** — your provider uses carrier-grade NAT, or two routers are chained. Ask the provider for a public IP, put the first router in bridge mode, or use Manual setup with a tunnel.
- **Windows asks whether Node.js may use the network** — allow it on private and public networks; that's Studio Host's server.
- **Guest stuck on "Connecting…"** — their network blocks peer-to-peer UDP; add a TURN server.
- **Guest can't use the camera** — they opened an `http://` link; invite links must be `https://`.
- **The dock shows a message instead of the controls on Linux** — OBS's built-in browser isn't available under Wayland. Click **Open in web browser** in the dock to use the controls in your browser.
- **Dock shows "Connecting…" or "Connection problem" on a guest** — the studio can't reach that guest over WebRTC. Usually a TURN server fixes it.
- **Guests hear themselves** — something on mixer track 6 carries their voice back. The likely cause is Desktop Audio picking up the guests while you monitor Studio Host Audio through your speakers. Use headphones for monitoring, or take that source off track 6 in Advanced Audio Properties.

To get more detail for a problem not listed here, start OBS with the environment variable `STUDIOHOST_DEBUG=1`. The studio pages then write their WebRTC negotiation steps to the OBS log (lines containing `[page …]`).

## Building

The plugin uses the official [obs-plugintemplate](https://github.com/obsproject/obs-plugintemplate) build system. GitHub Actions builds Windows, macOS (universal) and Ubuntu packages on pushes to `main`, tags and pull requests.

To build locally, fetch the Node.js runtime first, then build as with any plugin from the template:

```bash
build-aux/fetch-node linux-x64   # or: build-aux/fetch-node macos   (Windows: .\build-aux\Fetch-Node.ps1)
cmake --preset ubuntu-x86_64     # or macos / windows-x64
cmake --build --preset ubuntu-x86_64
```

The Node.js version is pinned in `build-aux/node-version`. Set `STUDIOHOST_NODE` to a `node` executable to use a different runtime when running OBS.

### Working on the server and pages

The server and pages live in `data/app/` and also run on their own, which is the quickest way to develop them:

```bash
npm start           # standalone server (data in ~/.studiohost); setup wizard at http://127.0.0.1:8730/setup/
npm test            # server, protocol, layout, DNS service, port mapping and setup tests
                    # (set PEBBLE_BIN/PEBBLE_DIR from .github/scripts/build-pebble to include certificate issuance)
npm run test:e2e    # multi-guest browser test; needs: npm i -D playwright && npx playwright install chromium
# test/obs-smoke.mjs runs against a real OBS with the plugin installed (see .github/scripts/obs-smoke-test)
```

Code map: `src/` (plugin), `data/app/server/` (server: studio, network setup, ACME client, port mapping), `data/app/public/` (guest app, producer dock, setup wizard, outputs, shared WebRTC/compositor code), `test/`.

## License

Studio Host is GPL-2.0-or-later (see `LICENSE`), matching OBS Studio, which the plugin links against.

### Bundled Node.js

The release packages include the official Node.js runtime (the version pinned in `build-aux/node-version`, currently v22.22.0) as a separate program that the plugin starts; Studio Host's server runs on it. Node.js is not covered by Studio Host's license. It is distributed under its own license:

- **Node.js** is licensed under the MIT License, Copyright Node.js contributors. All rights reserved.
- Node.js also includes third-party components (such as V8, libuv, OpenSSL, ICU and zlib), each under its own license.

The full Node.js license text, with every third-party notice, is the `LICENSE` file from the Node.js release. It ships with the runtime in every package, next to the `node` executable:

- Windows: `data\obs-plugins\studiohost\node\LICENSE`
- macOS: `studiohost.plugin/Contents/Resources/node/LICENSE`
- Linux: `/usr/share/obs/obs-plugins/studiohost/node/LICENSE`

It is also published with each Node.js release, for example <https://github.com/nodejs/node/blob/v22.22.0/LICENSE>.
