import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type Change, type DraftBridge } from "../shared/ipc.ts";

const bridge: DraftBridge = {
  boot: () => ipcRenderer.invoke(CHANNELS.boot),
  submit: (text, aside) => ipcRenderer.invoke(CHANNELS.submit, text, aside === true),
  setAgentState: (state) => ipcRenderer.invoke(CHANNELS.setAgentState, state),
  answerPrompt: (id, allow) => ipcRenderer.invoke(CHANNELS.answerPrompt, id, allow),
  setVisible: (targets) => ipcRenderer.send(CHANNELS.setVisible, targets),
  reportInvalidView: (reason) => ipcRenderer.send(CHANNELS.invalidView, reason),
  placements: () => ipcRenderer.invoke(CHANNELS.placements),
  setPlacement: (key, placement) => ipcRenderer.invoke(CHANNELS.setPlacement, key, placement),
  onChange: (cb) => {
    const listener = (_e: unknown, c: Change) => cb(c);
    ipcRenderer.on(CHANNELS.change, listener);
    return () => ipcRenderer.removeListener(CHANNELS.change, listener);
  },
};

contextBridge.exposeInMainWorld("draft", bridge);
