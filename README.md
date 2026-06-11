# VoiceCell 🎙

> Voice notes for Jupyter notebooks — record audio comments linked to specific lines of code.

**Author:** Muhammad Yahya Kamran  
**License:** MIT

## What it does

VoiceCell adds a **Voice Note** button to your JupyterLab toolbar. Click on any line of code, press the button (or `Alt+V`), and record a voice note. The recording is saved next to your notebook and a clickable 🔊 marker is injected into that exact line.

## Features

- 🎙 Record voice notes linked to specific cells and lines
- 🔊 Click the speaker icon to play back inline
- 🌊 Waveform visualization
- ⏩ Playback speed control (0.5x, 1x, 1.5x, 2x)
- 🗑 Delete voice notes from within the player
- 💾 Audio saved to `voicecells_of_(notebook)` folder alongside your notebook
- 📓 References stored in notebook metadata

## Installation

```bash
pip install jupyter-voicecell
```

Requires JupyterLab 4. After installing, restart JupyterLab.

## Usage

1. Open any notebook in JupyterLab
2. Click inside a cell on the line you want to annotate
3. Click **Voice Note** in the toolbar or press `Alt+V`
4. Record your message and click **Stop & Save**
5. A `# 🔊 vm_1 [timestamp]` comment appears on that line
6. Click the 🔊 to play it back anytime

## Sharing notebooks

Share the `.ipynb` file together with the `voicecells_of_<notebookname>` folder. Anyone with VoiceCell installed can play back all voice notes.

## Privacy & Safety

- 🔒 Microphone access is local only — browser permission required
- 💾 Audio saved locally as `.webm` files — never uploaded anywhere
- 🚫 No telemetry, no tracking, no external connections
- 📓 Metadata stored inside the notebook file itself

## Compatibility

- JupyterLab 4.x ✅
- Jupyter Notebook 7.x ✅
- PyCharm Jupyter notebooks — planned
- VS Code Jupyter notebooks — planned (requires separate VS Code extension)

## License

MIT © 2026 Muhammad Yahya Kamran