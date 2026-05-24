# Blood on the Clocktower Soundtrack

Static mobile web app for running soundtrack cues for Blood on the Clocktower.

Current stage cues:

- `SETUP`: starts `BotC Setup Loop.mp3` from the beginning, then loops from `00:28.369` to the end of the file.
- `DAY`: plays bells, fades Night out, and fades Day in.
- `NOMINATIONS`: plays the gong immediately, fades current music out over 3 seconds, then starts the Nominations loop after 2 seconds.
- `NIGHT`: fades Nominations out, plays the Night intro, and starts the Night loop.

## iPhone playback

On iOS 17 and newer, the app asks Safari for a `playback` audio session and sets Media Session metadata/state. This is the web platform path that can allow audio to continue with the Silent switch enabled and while the screen is locked.

iOS support still depends on Safari/WebKit. If a device or browser version ignores the web audio session request, a fully guaranteed solution requires a native iOS wrapper/app configured with Apple's playback audio session category and background audio mode.

## Local storage

The app uses the browser Cache Storage API and a service worker to save the app shell and audio files locally after they load. That means later visits can reuse the local copies instead of downloading the files again, and the app can keep working when the browser allows the cached files offline.
