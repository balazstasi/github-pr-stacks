# GitHub PR Stacks

A small browser extension that makes GitHub stacked pull requests easy to spot in PR lists.

On any `/pulls` list (for example **Authored by me**), pull requests that belong to a stack are:

- **Color-coded** per stack, with a colored rail and tinted background on each row.
- **Grouped** under a header with the stack number, size, base branch, a `#PR → #PR → #PR` chain (with open, draft and merged state dots) and an **Open stack** button.
- **Badged** with their position in the stack (`1/3`, `2/3`, ...), which links to the stack view.

A **Group stacks** checkbox above the list turns grouping off. PRs then keep GitHub's original order and only get the rail and badge. The choice is remembered.

It also works on the **Closed** tab, so merged stacks are recognised too, and it follows your light or dark GitHub theme.

## Install

Works in Chrome, Edge, Brave, Arc, Helium and other Chromium browsers.

1. Download `github-pr-stacks-vX.Y.Z.zip` from the [latest release](https://github.com/balazstasi/github-pr-stacks/releases/latest) and unzip it.
2. Open `chrome://extensions` (or `helium://extensions`, `edge://extensions`, ...).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).
5. Reload your GitHub PR page.

Keep the unzipped folder somewhere permanent. The browser loads the extension from it.

To update, download the new release, replace the folder contents and click the reload icon on the extension card.

## How it works

GitHub already exposes stack data as JSON:

- `/{owner}/{repo}/stacks` lists a repository's stacks (`?state=completed` for merged ones).
- `/{owner}/{repo}/stack/{number}` returns the ordered member PRs of one stack.

The content script fetches these with your existing GitHub session, matches PRs in the list by number, and decorates the rows. Nothing is sent anywhere else, no tokens are used, and the only permission requested is `storage` (to remember the grouping toggle). Results are cached for 60 seconds per repository.

These are GitHub's internal page endpoints, not a public API, so they may change. If the extension stops working after a GitHub UI update, please open an issue.

## Development

There is no build step. Edit the files in [`extension/`](extension) and reload the extension from `chrome://extensions`.

To build a release zip:

```sh
cd extension && zip -r ../github-pr-stacks-v$(grep -m1 '"version"' manifest.json | sed -E 's/.*"([0-9.]+)".*/\1/').zip . -x '.*'
```

## License

[MIT](LICENSE)
