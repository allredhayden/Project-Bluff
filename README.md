# Project Bluff

Project Bluff is a mobile-first Blood on the Clocktower soundtrack and lighting controller. Its local Flask server plays no audio itself: the controlling browser runs the existing soundtrack while the server keeps shared stage state and sends either native Art-Net frames or mapped OSC messages.

## Supported modes

### Public audio-only site

The root HTML, CSS, JavaScript, service worker, and sound files remain a static site. GitHub Pages can continue serving audio, timers, DAY sound choices, volume settings, and offline-cached assets.

Lighting configuration is disabled when the page is not connected to the local Bluff server.

### Local soundtrack and lighting control

Run the Bluff server on the show computer and open it from that computer or a phone on the same private network. All connected pages share the current stage, timer, lighting engine, and lighting configuration. The browser where a stage is tapped plays the soundtrack; the server independently sends lighting through the selected engine.

The saved engine selector is mutually exclusive: `ART-NET` uses Bluff's native DMX engine, while `OSC` sends complete event messages to QLab or another OSC receiver. Both engines use the same Arm control and start disarmed after every server launch.

Lighting supports exactly two fixed 10-channel fixtures:

| Fixture | Physical channels 1 through 10 |
|---|---|
| SHEHDS Mini PAR 7x18W RGBWA+UV | Dimmer, Red, Green, Blue, White, Amber, UV, Strobe, Auto Program, Auto Speed |
| SHEHDS PAR 18x18W RGBWA+UV | Dimmer, Red, Green, Blue, White, Amber, UV, Strobe, Auto Program, Auto Speed |

The editor displays each fixture in its physical DMX order. Both supported 10-channel modes show Dimmer, colors, then functions.

## Install and start

The simplest macOS launch is to double-click `launch_bluff_server.command`. On its first run it creates `.venv`, installs the dependencies, and starts Waitress on port `5050`.

The equivalent terminal setup is:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py
```

Open the printed loopback URL on the computer:

```text
http://127.0.0.1:5050
```

Open the printed LAN URL on the phone, for example:

```text
http://192.168.1.155:5050
```

Optional server overrides:

```bash
BLUFF_HOST=0.0.0.0 BLUFF_PORT=5050 .venv/bin/python server.py
BLUFF_LIGHTING_CONFIG_PATH=/safe/private/path/lighting-config.json .venv/bin/python server.py
```

Runtime lighting configuration is stored in `instance/lighting-config.json`, which is ignored by Git. `lighting-config.example.json` documents the safe empty schema.

## Native Art-Net setup

1. Start the local Bluff server.
2. Open Settings, then Lighting, and select `ART-NET`.
3. Open Art-Net Output. Leave Target at `255.255.255.255` for broadcast, or enter the node address for unicast. Enter the show-network interface address only when the computer needs an explicit adapter binding.
4. Add each fixture, name it, select 7x18 or 18x18, and enter its show universe and starting DMX address.
5. Select each fixed trigger: Setup, Day, Nominations, Night, and Stop All.
6. Program the ALL card for each fixture profile, then add only the individual fixture values that should override it. Blank individual values inherit the ALL card. Choose Fade or Snap for each programmed parameter. Auto Program always snaps.
7. Set the cue fade time and save.
8. Click Arm Art-Net once after each server launch. Arming begins with an all-zero HOME frame.
9. Leave the editor in LIVE to recall a look by selecting its tab and transmit value changes as you edit. Choose BLIND to keep output on the current game look while editing other looks.
10. Click Disarm + Blackout when finished.

While armed, cue values and timing are validated and saved live. Fixture patch and Art-Net network changes remain locked until lighting is disarmed.

## QLab OSC setup

1. In QLab Workspace Settings, enable OSC access and grant Control permission to the `No Passcode` row. Bluff does not perform QLab's workspace/passcode handshake.
2. Leave QLab on its default OSC listener port `53000`, or note the custom workspace port.
3. In Bluff Settings, open Lighting and select `OSC`.
4. Use `127.0.0.1` when QLab and Bluff run on the same Mac. Otherwise enter the QLab computer's private-network address. Enter QLab's OSC port.
5. Enter the complete message for each event. Examples include `/go`, `/cue/12/start`, or `/cue/DAY/start`. Optional arguments must be quoted when they contain spaces.
6. Save OSC, then click Arm OSC. At least one mapped event is required before arming.
7. Use `SEND TEST` beside a saved event while OSC is armed. A successful result proves only that Bluff sent a UDP datagram; confirm execution in QLab.
8. Click Disarm OSC when finished.

The eight independent OSC mappings are Setup, Day, Nominations, Night, Stop All, Bells, Male Scream, and Female Scream. A blank mapping is skipped. Bells and scream messages fire after the primary Day message only when those sounds actually play; toggling their arming buttons does not send OSC.

While armed, OSC message text can be saved, but the lighting engine and OSC destination remain locked. Disarm before switching back to Art-Net.

## Cue behavior

- Every trigger resolves to one complete deterministic look; there is no tracking from a previous cue.
- LIVE is the default editor mode. Selecting a look recalls it, and editing that look updates output.
- BLIND keeps output on the current game stage. Selecting or editing a different look does not change output; editing the active game look updates it.
- Each supported fixture profile gets an ALL cue card. It is the low-priority baseline for every light of that type.
- A programmed individual fixture value overrides the ALL card, including an explicit value of zero. A blank individual value inherits the ALL value; if both layers are blank, it resolves to HOME zero.
- Clear removes every programmed value from that card. Clearing an individual restores inheritance, while clearing an ALL card leaves individual overrides intact.
- One linear fade time applies to the cue.
- Checked parameters fade and unchecked parameters snap at cue start.
- Auto Program always snaps because it is an indexed function channel.
- A new trigger during a fade begins from the values being emitted at that exact moment.
- Pressing an already-active stage remains ignored by the main interface.
- In Art-Net mode, Bells and scream choices affect audio only. In OSC mode, their separate mappings send only when those sounds actually play during DAY.
- Stop All runs its own configurable lighting look while fading local audio.

The Art-Net runtime refreshes configured universes continuously at the saved rate, defaulting to 30 Hz. Art-Net and OSC both use UDP and provide no receiver acknowledgment. Bluff reports local send failures, but only a physical output check proves that the node, fixtures, or QLab executed a command.

## Safety and network boundaries

- Lighting always starts disarmed after a server launch.
- Art-Net Arm sends an all-zero HOME frame before any cue; OSC Arm sends nothing and enables mapped event transmission.
- Art-Net Disarm sends a blackout frame and stops output; OSC Disarm stops transmission without sending a cue.
- The selected engine cannot change while armed, and the inactive engine never emits output.
- A normal server shutdown attempts the same blackout, although power loss or forced termination cannot guarantee it.
- Lighting failures never cancel or roll back the browser's audio cue.
- All lighting API responses are non-cacheable, and the service worker bypasses `/api/` requests.
- Use Bluff only on a trusted private show network. The local HTTP control page has no account system and should not be exposed to the public internet.

## Soundtrack behavior

- `SETUP` starts `BotC Setup Loop.mp3` from the beginning, then loops from `00:28.369` to the end.
- `DAY` plays Bells when armed, fades Night out, and fades Day in. Armed scream choices play only when DAY starts.
- `NOMINATIONS` plays the gong immediately, fades current music out over three seconds, then starts the Nominations loop after two seconds.
- `NIGHT` fades Nominations out, plays the Night intro, and starts the Night loop.
- `STOP ALL` fades all local audio and runs the saved Stop All lighting look.

## Tests

Install development dependencies and run all automated checks:

```bash
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
node --test tests/frontend_behavior.test.js
node --check app.js
node --check lighting-control.js
node --check service-worker.js
```

The Python suite validates both fixture channel maps, lossless version 1/2 migration, sparse profile/fixture priority, exclusive engine routing, all eight OSC events, exact OSC and ArtDMX packet bytes, fades, interrupted transitions, blackout, shared controllers, and real loopback UDP packets.

## iPhone playback

On iOS 17 and newer, Bluff asks Safari for a `playback` audio session and sets Media Session metadata/state. This is the web-platform path that can allow audio to continue with the Silent switch enabled and while the screen is locked.

iOS behavior still depends on Safari/WebKit. Guaranteed playback requires a native iOS wrapper configured with Apple's playback audio-session category and background-audio mode.
