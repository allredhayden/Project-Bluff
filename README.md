# Blood on the Clocktower Soundtrack

Static mobile web app for running the game soundtrack cues.

## Local testing

Run the app through a local HTTP server so the browser can fetch and decode the audio files:

```powershell
py -3 -m http.server 4173
```

Then open:

```text
http://localhost:4173
```

The app starts preloading and decoding every file in `sounds/` as soon as the page opens. The progress bar shows download and decode progress. The first stage tap resumes browser audio playback and starts the selected cue.

## iPhone playback

On iOS 17 and newer, the app asks Safari for a `playback` audio session and sets Media Session metadata/state. This is the web platform path that can allow audio to continue with the Silent switch enabled and while the screen is locked.

iOS support still depends on Safari/WebKit. If a device or browser version ignores the web audio session request, a fully guaranteed solution requires a native iOS wrapper/app configured with Apple's playback audio session category and background audio mode.

## Local storage

The app uses the browser Cache Storage API and a service worker to save the app shell and audio files locally after they load. That means later visits can reuse the local copies instead of downloading the files again, and the app can keep working when the browser allows the cached files offline.

This works on `localhost` and on HTTPS hosting such as GitHub Pages. Browsers can still evict cached files if storage is low, so keep the original files in `sounds/` in the repository.

## Deploying for free

GitHub Pages can host this app without a build step:

1. Commit `index.html`, `styles.css`, `app.js`, `service-worker.js`, `README.md`, and the `sounds/` folder.
2. Push the branch to GitHub.
3. In the repository settings, open Pages.
4. Set the source to deploy from the branch root.
5. Save and use the Pages URL GitHub provides.

Keep the audio files in `sounds/` with their current names so the app paths continue to resolve.
