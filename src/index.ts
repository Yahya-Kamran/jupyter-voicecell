import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { INotebookTracker } from '@jupyterlab/notebook';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

const plugin: JupyterFrontEndPlugin<void> = {
  id: 'voicecell:plugin',
  description: 'Voice comments for Jupyter notebook cells.',
  autoStart: true,
  requires: [INotebookTracker, ISettingRegistry],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker, _settings: ISettingRegistry) => {
    console.log('JupyterLab extension voicecell is activated!');

    let mediaRecorder: MediaRecorder | null = null;
    let audioChunks: Blob[] = [];
    let isRecording = false;
    let recordingPanel: HTMLDivElement | null = null;
    let pendingCellId: string | null = null;
    let pendingLine: number | null = null;
    let activePlayer: HTMLDivElement | null = null;
    let activeAudio: HTMLAudioElement | null = null;

    const removeRecordingPanel = () => {
      if (recordingPanel?.parentNode) {
        recordingPanel.parentNode.removeChild(recordingPanel);
        recordingPanel = null;
      }
    };

    const removeActivePlayer = () => {
      if (activeAudio) { activeAudio.pause(); activeAudio = null; }
      if (activePlayer?.parentNode) {
        activePlayer.parentNode.removeChild(activePlayer);
        activePlayer = null;
      }
    };

    const showToast = (msg: string, color = '#2d9a4e') => {
      const toast = document.createElement('div');
      toast.textContent = msg;
      toast.style.cssText = `
        position:fixed; bottom:32px; left:50%; transform:translateX(-50%);
        background:${color}; color:#fff; padding:10px 24px;
        border-radius:8px; font-family:sans-serif; font-size:14px;
        z-index:10001; box-shadow:0 4px 12px rgba(0,0,0,0.3);
      `;
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
    };

    const getBaseUrl = () => window.location.origin + '/';
    const getXsrf = () =>
      document.cookie.split('; ').find(r => r.startsWith('_xsrf='))?.split('=')[1] ?? '';

    // Resolve timestamp-based short ID to full filename using notebook metadata
    const resolveFilename = (shortId: string): string | null => {
      const notebook = tracker.currentWidget;
      if (!notebook) return null;
      const meta = (notebook.content.model?.getMetadata('voicenotes') as Record<string, any>) ?? {};
      for (const cId of Object.keys(meta)) {
        for (const lKey of Object.keys(meta[cId])) {
          for (const entry of meta[cId][lKey]) {
            const file = entry.file as string;
            const fname = file.includes('/') ? file.substring(file.lastIndexOf('/') + 1) : file;
            if (fname.includes(`_${shortId}.webm`)) return fname;
          }
        }
      }
      return null;
    };

    const drawWaveform = async (canvas: HTMLCanvasElement, blob: Blob) => {
      try {
        const arrayBuffer = await blob.arrayBuffer();
        const ctx = new AudioContext();
        const decoded = await ctx.decodeAudioData(arrayBuffer);
        const data = decoded.getChannelData(0);
        const w = canvas.width;
        const h = canvas.height;
        const c = canvas.getContext('2d')!;
        const step = Math.ceil(data.length / w);
        const amp = h / 2;
        c.clearRect(0, 0, w, h);
        for (let i = 0; i < w; i++) {
          let min = 1, max = -1;
          for (let j = 0; j < step; j++) {
            const d = data[i * step + j] ?? 0;
            if (d < min) min = d;
            if (d > max) max = d;
          }
          const barH = Math.max(2, (max - min) * amp * 0.9);
          c.fillStyle = 'rgba(255,255,255,0.5)';
          c.fillRect(i, amp - barH / 2, 1, barH);
        }
        await ctx.close();
      } catch (e) {
        console.warn('voicecell: waveform draw failed', e);
      }
    };

    const deleteVoiceNote = async (filename: string, cellNode: HTMLElement) => {
      const notebook = tracker.currentWidget;
      if (!notebook) return;

      const notebookPath = notebook.context.path;
      const notebookName = (notebookPath.includes('/')
        ? notebookPath.substring(notebookPath.lastIndexOf('/') + 1)
        : notebookPath).replace('.ipynb', '');
      const notebookDir = notebookPath.includes('/')
        ? notebookPath.substring(0, notebookPath.lastIndexOf('/'))
        : '';
      const folderPath = notebookDir
        ? `${notebookDir}/voicecells_of_${notebookName}`
        : `voicecells_of_${notebookName}`;
      const filePath = `${folderPath}/${filename}`;

      await fetch(`${getBaseUrl()}api/contents/${encodeURIComponent(filePath)}`, {
        method: 'DELETE',
        headers: { 'X-XSRFToken': getXsrf() }
      });

      const notebookModel = notebook.content.model;
      if (notebookModel) {
        const meta = (notebookModel.getMetadata('voicenotes') as Record<string, any>) ?? {};
        for (const cId of Object.keys(meta)) {
          for (const lKey of Object.keys(meta[cId])) {
            meta[cId][lKey] = meta[cId][lKey].filter(
              (e: any) => !(e.file as string).endsWith(filename)
            );
            if (meta[cId][lKey].length === 0) delete meta[cId][lKey];
          }
          if (Object.keys(meta[cId]).length === 0) delete meta[cId];
        }
        notebookModel.setMetadata('voicenotes', meta);
      }

      for (const cell of notebook.content.widgets) {
        if (!cell.node.contains(cellNode) && cell.node !== cellNode) continue;
        const src = cell.model.sharedModel.getSource();
        const cleaned = src.split('\n').map(l =>
          l.replace(/\s*#\s*🔊\s*vm_\d+\s*\[[^\]]+\]/g, '')
        ).join('\n');
        cell.model.sharedModel.setSource(cleaned);
        break;
      }

      removeActivePlayer();
      showToast('🗑 Voice note deleted');
    };

    const showAudioPlayer = async (
      shortId: string,
      displayName: string,
      anchorEl: HTMLElement,
      cellNode: HTMLElement
    ) => {
      removeActivePlayer();

      const filename = resolveFilename(shortId);
      if (!filename) { showToast('❌ Could not find audio file', '#c0392b'); return; }

      const notebook = tracker.currentWidget;
      if (!notebook) return;

      const notebookPath = notebook.context.path;
      const notebookName = (notebookPath.includes('/')
        ? notebookPath.substring(notebookPath.lastIndexOf('/') + 1)
        : notebookPath).replace('.ipynb', '');
      const notebookDir = notebookPath.includes('/')
        ? notebookPath.substring(0, notebookPath.lastIndexOf('/'))
        : '';
      const folderPath = notebookDir
        ? `${notebookDir}/voicecells_of_${notebookName}`
        : `voicecells_of_${notebookName}`;
      const filePath = `${folderPath}/${filename}`;

      let blob: Blob;
      try {
        const res = await fetch(
          `${getBaseUrl()}api/contents/${encodeURIComponent(filePath)}?content=1`,
          { headers: { 'X-XSRFToken': getXsrf() } }
        );
        if (!res.ok) { showToast('❌ Could not load audio file', '#c0392b'); return; }
        const data = await res.json();
        const binary = atob(data.content);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        blob = new Blob([bytes], { type: 'audio/webm' });
      } catch {
        showToast('❌ Failed to load audio', '#c0392b');
        return;
      }

      const audioUrl = URL.createObjectURL(blob);
      const audio = new Audio(audioUrl);
      activeAudio = audio;

      const rect = anchorEl.getBoundingClientRect();
      const player = document.createElement('div');
      player.style.cssText = `
        position:fixed;
        top:${rect.bottom + 8}px;
        left:${Math.min(rect.left, window.innerWidth - 340)}px;
        width:320px; background:#1a1a2e; border:1px solid #444;
        border-radius:16px; padding:14px 16px; z-index:10000;
        box-shadow:0 8px 32px rgba(0,0,0,0.6); font-family:sans-serif; color:#fff;
      `;

      player.innerHTML = `
        <div style="display:flex; align-items:center; gap:10px; margin-bottom:10px;">
          <button id="vc-play" style="
            background:#4a9eff; border:none; border-radius:50%;
            width:38px; height:38px; cursor:pointer; font-size:15px;
            color:#fff; flex-shrink:0; display:flex;
            align-items:center; justify-content:center;">▶</button>
          <div style="flex:1; font-size:13px; color:#ddd; font-weight:500;">${displayName}</div>
          <div id="vc-time" style="font-size:11px; color:#aaa; flex-shrink:0;">0:00</div>
          <button id="vc-delete" title="Delete voice note" style="
            background:none; border:none; color:#e05555;
            cursor:pointer; font-size:15px; padding:2px 4px; flex-shrink:0;">🗑</button>
          <button id="vc-close" style="
            background:none; border:none; color:#888;
            cursor:pointer; font-size:16px; padding:2px 4px; flex-shrink:0;">✕</button>
        </div>
        <div style="position:relative; margin-bottom:10px; border-radius:8px; overflow:hidden;">
          <canvas id="vc-wave" width="288" height="48" style="
            width:100%; height:48px; background:#0d0d1a; display:block;"></canvas>
          <div id="vc-playhead" style="
            position:absolute; top:0; left:0; width:0%; height:100%;
            background:rgba(74,158,255,0.2);
            border-right:2px solid #4a9eff; pointer-events:none;"></div>
          <div id="vc-bar" style="
            position:absolute; top:0; left:0;
            width:100%; height:100%; cursor:pointer;"></div>
        </div>
        <div style="display:flex; gap:4px;">
          ${['0.5', '1', '1.5', '2'].map(s => `
            <button class="vc-speed" data-speed="${s}" style="
              background:${s === '1' ? '#4a9eff' : '#2a2a3e'};
              border:none; border-radius:6px; color:#fff;
              padding:3px 8px; cursor:pointer; font-size:11px;
              font-weight:${s === '1' ? 'bold' : 'normal'};">${s}x</button>
          `).join('')}
        </div>
      `;

      document.body.appendChild(player);
      activePlayer = player;

      const playBtn = player.querySelector('#vc-play') as HTMLButtonElement;
      const timeEl = player.querySelector('#vc-time') as HTMLElement;
      const playhead = player.querySelector('#vc-playhead') as HTMLElement;
      const bar = player.querySelector('#vc-bar') as HTMLElement;
      const canvas = player.querySelector('#vc-wave') as HTMLCanvasElement;

      drawWaveform(canvas, blob);

      const fmt = (t: number) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
      };

      audio.ontimeupdate = () => {
        if (!audio.duration) return;
        playhead.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
        timeEl.textContent = `${fmt(audio.currentTime)} / ${fmt(audio.duration)}`;
      };

      audio.onended = () => {
        playBtn.textContent = '▶';
        playhead.style.width = '0%';
        audio.currentTime = 0;
      };

      playBtn.onclick = () => {
        if (audio.paused) { audio.play(); playBtn.textContent = '⏸'; }
        else { audio.pause(); playBtn.textContent = '▶'; }
      };

      bar.onclick = (e: MouseEvent) => {
        const r = bar.getBoundingClientRect();
        if (audio.duration) audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
      };

      player.querySelectorAll('.vc-speed').forEach(btn => {
        (btn as HTMLButtonElement).onclick = () => {
          const speed = parseFloat((btn as HTMLButtonElement).dataset.speed ?? '1');
          audio.playbackRate = speed;
          player.querySelectorAll('.vc-speed').forEach(b => {
            (b as HTMLButtonElement).style.background = '#2a2a3e';
            (b as HTMLButtonElement).style.fontWeight = 'normal';
          });
          (btn as HTMLButtonElement).style.background = '#4a9eff';
          (btn as HTMLButtonElement).style.fontWeight = 'bold';
        };
      });

      (player.querySelector('#vc-delete') as HTMLButtonElement).onclick = async () => {
        if (!confirm(`Delete ${displayName}? This cannot be undone.`)) return;
        await deleteVoiceNote(filename, cellNode);
      };

      (player.querySelector('#vc-close') as HTMLButtonElement).onclick = () => removeActivePlayer();

      audio.play();
      playBtn.textContent = '⏸';
    };

    const voiceNoteOverlays = new Map<HTMLElement, Map<number, { shortId: string; displayName: string }>>();

    const renderOverlays = () => {
      const notebook = tracker.currentWidget;
      if (!notebook) return;

      notebook.content.widgets.forEach(cell => {
        const source = cell.model.sharedModel.getSource();
        const lines = source.split('\n');
        const cellNode = cell.node;

        const noteLines = new Map<number, { shortId: string; displayName: string }>();
        lines.forEach((lineText, idx) => {
          // New format: # 🔊 vm_1 [1781167798084]
          const match = lineText.match(/# 🔊 (vm_\d+) \[(\d+)\]/);
          // Old full filename format for backwards compat
          const oldMatch = lineText.match(/# 🔊 (vm_\d+) \[([^\]]+\.webm)\]/);
          if (match) {
            noteLines.set(idx, { displayName: match[1], shortId: match[2] });
          } else if (oldMatch) {
            const tsMatch = oldMatch[2].match(/_(\d+)\.webm$/);
            const shortId = tsMatch ? tsMatch[1] : oldMatch[2];
            noteLines.set(idx, { displayName: oldMatch[1], shortId });
          }
        });
        voiceNoteOverlays.set(cellNode, noteLines);

        if (!(cellNode as any)._vcListenerAttached) {
          (cellNode as any)._vcListenerAttached = true;
          cellNode.addEventListener('click', (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const cmLine = target.closest('.cm-line') as HTMLElement | null;
            if (!cmLine) return;
            const lineText = cmLine.textContent ?? '';
            if (!lineText.includes('🔊')) return;

            const allLines = cellNode.querySelectorAll('.cm-line');
            let lineIdx = -1;
            allLines.forEach((el, i) => { if (el === cmLine) lineIdx = i; });
            if (lineIdx === -1) return;

            const note = voiceNoteOverlays.get(cellNode)?.get(lineIdx);
            if (!note) return;

            let node: HTMLElement | null = target;
            let found = false;
            while (node && node !== cmLine) {
              if (node.textContent?.includes('🔊')) { found = true; break; }
              node = node.parentElement;
            }
            if (!found) return;

            e.stopPropagation();
            showAudioPlayer(note.shortId, note.displayName, cmLine, cellNode);
          });
        }
      });
    };

    const injectCommentIntoCell = (
      cellId: string,
      line: number,
      shortId: string,
      displayName: string
    ) => {
      const notebook = tracker.currentWidget;
      if (!notebook) return;
      for (const cell of notebook.content.widgets) {
        if (cell.model.id !== cellId) continue;
        if (!cell.editor) break;
        const src = cell.model.sharedModel.getSource();
        const lines = src.split('\n');
        const idx = line - 1;
        lines[idx] = (lines[idx] ?? '').trimEnd() + `  # 🔊 ${displayName} [${shortId}]`;
        cell.model.sharedModel.setSource(lines.join('\n'));
        break;
      }
    };

    const saveVoiceNote = async (
      audioBlob: Blob,
      cellId: string,
      line: number
    ): Promise<{ shortId: string; displayName: string } | null> => {
      const notebook = tracker.currentWidget;
      if (!notebook) return null;

      const notebookPath = notebook.context.path;
      const notebookName = (notebookPath.includes('/')
        ? notebookPath.substring(notebookPath.lastIndexOf('/') + 1)
        : notebookPath).replace('.ipynb', '');
      const notebookDir = notebookPath.includes('/')
        ? notebookPath.substring(0, notebookPath.lastIndexOf('/'))
        : '';

      const timestamp = Date.now();
      const shortId = String(timestamp);
      const filename = `voice_${cellId.substring(0, 8)}_line${line}_${timestamp}.webm`;
      const folderPath = notebookDir
        ? `${notebookDir}/voicecells_of_${notebookName}`
        : `voicecells_of_${notebookName}`;
      const filePath = `${folderPath}/${filename}`;

      const arrayBuffer = await audioBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      let binary = '';
      uint8Array.forEach(b => (binary += String.fromCharCode(b)));
      const base64 = btoa(binary);

      await fetch(`${getBaseUrl()}api/contents/${encodeURIComponent(folderPath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-XSRFToken': getXsrf() },
        body: JSON.stringify({ type: 'directory' })
      });

      const fileRes = await fetch(`${getBaseUrl()}api/contents/${encodeURIComponent(filePath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-XSRFToken': getXsrf() },
        body: JSON.stringify({ type: 'file', format: 'base64', content: base64 })
      });

      if (!fileRes.ok) return null;

      const notebookModel = notebook.content.model;
      let vmCount = 1;
      if (notebookModel) {
        const meta = (notebookModel.getMetadata('voicenotes') as Record<string, any>) ?? {};
        for (const cId of Object.keys(meta))
          for (const lKey of Object.keys(meta[cId]))
            vmCount += meta[cId][lKey].length;
        if (!meta[cellId]) meta[cellId] = {};
        if (!meta[cellId][line]) meta[cellId][line] = [];
        meta[cellId][line].push({ file: filePath, timestamp, displayName: `vm_${vmCount}` });
        notebookModel.setMetadata('voicenotes', meta);
      }

      return { shortId, displayName: `vm_${vmCount}` };
    };

    const showRecordingUI = (cellId: string, line: number) => {
      removeRecordingPanel();
      const panel = document.createElement('div');
      panel.style.cssText = `
        position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
        background:#1e1e2e; border:1px solid #555; border-radius:14px;
        padding:28px 32px; z-index:10000; box-shadow:0 8px 40px rgba(0,0,0,0.6);
        min-width:320px; text-align:center; color:#fff; font-family:sans-serif;
      `;
      panel.innerHTML = `
        <div style="font-size:13px;color:#aaa;margin-bottom:10px;">
          Recording for <code style="background:#333;padding:2px 6px;
          border-radius:4px;font-size:12px">
            Cell ${cellId.substring(0, 8)}... · Line ${line}</code>
        </div>
        <div style="font-size:32px;margin-bottom:4px;">🎙</div>
        <div style="width:12px;height:12px;border-radius:50%;background:#ff6b6b;
          margin:0 auto 12px;animation:vcpulse 1s infinite;"></div>
        <style>@keyframes vcpulse{
          0%,100%{opacity:1;transform:scale(1)}
          50%{opacity:0.4;transform:scale(1.4)}
        }</style>
        <div id="vc-timer" style="font-size:36px;font-weight:bold;margin-bottom:24px;
          font-variant-numeric:tabular-nums;letter-spacing:2px;">0:00</div>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="vc-stop" style="background:#ff6b6b;color:#fff;border:none;
            padding:11px 28px;border-radius:8px;cursor:pointer;
            font-size:14px;font-weight:bold;">⏹ Stop & Save</button>
          <button id="vc-cancel" style="background:#444;color:#fff;border:none;
            padding:11px 20px;border-radius:8px;cursor:pointer;font-size:14px;">
            ✕ Cancel</button>
        </div>
      `;
      document.body.appendChild(panel);
      recordingPanel = panel;

      let seconds = 0;
      const timerEl = panel.querySelector('#vc-timer') as HTMLElement;
      const timerInterval = setInterval(() => {
        seconds++;
        timerEl.textContent = `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`;
      }, 1000);

      (panel.querySelector('#vc-stop') as HTMLButtonElement).onclick = () => {
        clearInterval(timerInterval);
        if (mediaRecorder && isRecording) { mediaRecorder.stop(); isRecording = false; }
      };

      (panel.querySelector('#vc-cancel') as HTMLButtonElement).onclick = () => {
        clearInterval(timerInterval);
        if (mediaRecorder && isRecording) {
          mediaRecorder.ondataavailable = null;
          mediaRecorder.onstop = null;
          mediaRecorder.stop();
          isRecording = false;
        }
        audioChunks = []; pendingCellId = null; pendingLine = null;
        removeRecordingPanel();
      };
    };

    const startRecording = async (cellId: string, line: number) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = []; pendingCellId = cellId; pendingLine = line;
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
        mediaRecorder.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          removeRecordingPanel();
          if (!pendingCellId || pendingLine === null) return;
          const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
          const result = await saveVoiceNote(audioBlob, pendingCellId, pendingLine);
          if (result) {
            injectCommentIntoCell(pendingCellId, pendingLine, result.shortId, result.displayName);
            showToast('✅ Voice note saved!');
            setTimeout(renderOverlays, 400);
          } else {
            showToast('❌ Failed to save voice note', '#c0392b');
          }
          pendingCellId = null; pendingLine = null;
        };
        mediaRecorder.start();
        isRecording = true;
        showRecordingUI(cellId, line);
      } catch (err) {
        alert('Microphone access denied.');
        console.error('voicecell: microphone error', err);
      }
    };

    app.commands.addCommand('voicecell:record-note', {
      label: '🎙 Voice Note',
      execute: () => {
        const activeCell = tracker.activeCell;
        if (!activeCell) { showToast('Please click inside a cell first!', '#e67e22'); return; }
        const cellId = activeCell.model.id;
        const editor = activeCell.editor;
        let line = 1;
        if (editor) line = editor.getCursorPosition().line + 1;
        startRecording(cellId, line);
      }
    });

    app.commands.addKeyBinding({
      command: 'voicecell:record-note',
      keys: ['Alt V'],
      selector: '.jp-Notebook'
    });

    const interval = setInterval(() => {
      if (document.querySelector('.jp-NotebookPanel-toolbar')) {
        renderOverlays();
        clearInterval(interval);
      }
    }, 500);

    tracker.currentChanged.connect(() => setTimeout(renderOverlays, 500));
    tracker.widgetAdded.connect(() => setTimeout(renderOverlays, 800));
  }
};

export default plugin;