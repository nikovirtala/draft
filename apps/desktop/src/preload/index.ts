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
  settleInterrupt: (conversation, key, outcome, input) =>
    ipcRenderer.invoke(CHANNELS.settleInterrupt, conversation, key, outcome, input ?? {}),
  answerCheck: (conversation, key, outcome, note) =>
    ipcRenderer.invoke(CHANNELS.answerCheck, conversation, key, outcome, note ?? null),
  copyText: (text) => ipcRenderer.invoke(CHANNELS.copyText, text),
  wrapUp: (conversation) => ipcRenderer.invoke(CHANNELS.wrapUp, conversation),
  confirmConclusion: (conversation) => ipcRenderer.invoke(CHANNELS.confirmConclusion, conversation),
  declineConclusion: (conversation) => ipcRenderer.invoke(CHANNELS.declineConclusion, conversation),
  endThread: (conversation, as, reason) =>
    ipcRenderer.invoke(CHANNELS.endThread, conversation, as, reason),
  trust: (answer) => ipcRenderer.invoke(CHANNELS.trust, answer),
  contexts: () => ipcRenderer.invoke(CHANNELS.contexts),
  openContext: (name) => ipcRenderer.invoke(CHANNELS.openContext, name),
  chooseFolder: () => ipcRenderer.invoke(CHANNELS.chooseFolder),
  chooseImport: () => ipcRenderer.invoke(CHANNELS.chooseImport),
  answerProposal: (conversation, id, accept) =>
    ipcRenderer.invoke(CHANNELS.answerProposal, conversation, id, accept),
  followReference: (conversation, address) =>
    ipcRenderer.invoke(CHANNELS.followReference, conversation, address),
  pullReference: (conversation, address) =>
    ipcRenderer.invoke(CHANNELS.pullReference, conversation, address),
  map: (request) => ipcRenderer.invoke(CHANNELS.map, request ?? {}),
  setMapVisible: (on) => ipcRenderer.send(CHANNELS.mapVisible, on),
  selectMapCell: (block, cell) => ipcRenderer.invoke(CHANNELS.selectMapCell, block, cell),
  setPanelWidth: (width) => ipcRenderer.invoke(CHANNELS.setPanelWidth, width),
  onChange: (cb) => {
    const listener = (_e: unknown, c: Change) => cb(c);
    ipcRenderer.on(CHANNELS.change, listener);
    return () => ipcRenderer.removeListener(CHANNELS.change, listener);
  },
};

contextBridge.exposeInMainWorld("draft", bridge);
