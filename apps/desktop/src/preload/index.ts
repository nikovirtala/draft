import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS, type Change, type DraftBridge } from "../shared/ipc.ts";

const bridge: DraftBridge = {
  boot: () => ipcRenderer.invoke(CHANNELS.boot),
  submit: (conversation, text, aside) =>
    ipcRenderer.invoke(CHANNELS.submit, conversation, text, aside === true),
  setAgentState: (conversation, state) =>
    ipcRenderer.invoke(CHANNELS.setAgentState, conversation, state),
  answerPrompt: (conversation, id, allow) =>
    ipcRenderer.invoke(CHANNELS.answerPrompt, conversation, id, allow),
  setVisible: (targets) => ipcRenderer.send(CHANNELS.setVisible, targets),
  reportInvalidView: (reason) => ipcRenderer.send(CHANNELS.invalidView, reason),
  ensureBlocks: (blocks) => ipcRenderer.invoke(CHANNELS.ensureBlocks, blocks),
  move: (move) => ipcRenderer.invoke(CHANNELS.move, move),
  focus: (target) => ipcRenderer.invoke(CHANNELS.focus, target),
  branch: (parentMessage, agent) => ipcRenderer.invoke(CHANNELS.branch, parentMessage, agent),
  previewSwitch: (conversation, agent) =>
    ipcRenderer.invoke(CHANNELS.previewSwitch, conversation, agent),
  switchAgent: (conversation, agent) =>
    ipcRenderer.invoke(CHANNELS.switchAgent, conversation, agent),
  settleInterrupt: (conversation, key, outcome) =>
    ipcRenderer.invoke(CHANNELS.settleInterrupt, conversation, key, outcome),
  wrapUp: (conversation) => ipcRenderer.invoke(CHANNELS.wrapUp, conversation),
  confirmConclusion: (conversation) => ipcRenderer.invoke(CHANNELS.confirmConclusion, conversation),
  declineConclusion: (conversation) => ipcRenderer.invoke(CHANNELS.declineConclusion, conversation),
  endThread: (conversation, as, reason) =>
    ipcRenderer.invoke(CHANNELS.endThread, conversation, as, reason),
  onChange: (cb) => {
    const listener = (_e: unknown, c: Change) => cb(c);
    ipcRenderer.on(CHANNELS.change, listener);
    return () => ipcRenderer.removeListener(CHANNELS.change, listener);
  },
};

contextBridge.exposeInMainWorld("draft", bridge);
