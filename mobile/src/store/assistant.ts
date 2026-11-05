import { create } from 'zustand';

/** One message in the single conversation (R-52). Local-only stub until /chat/messages (week 5). */
export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** Page id where it was said, or 'today'. Used for «— на странице X, 14:20 —» dividers. */
  pageId: string;
  pageTitle: string;
  at: string;
};

export type Banner = { messageId: string; text: string };

type AssistantState = {
  /** «Про: все страницы» toggle on the context chip. */
  aboutAll: boolean;
  listening: boolean;
  banner: Banner | null;
  messages: ChatMessage[];
  setAboutAll: (v: boolean) => void;
  setListening: (v: boolean) => void;
  showBanner: (b: Banner) => void;
  closeBanner: () => void;
  addMessage: (m: ChatMessage) => void;
  reset: () => void;
};

export const useAssistant = create<AssistantState>()((set) => ({
  aboutAll: false,
  listening: false,
  banner: null,
  messages: [],
  setAboutAll: (aboutAll) => set({ aboutAll }),
  setListening: (listening) => set({ listening }),
  showBanner: (banner) => set({ banner }),
  closeBanner: () => set({ banner: null }),
  addMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),
  reset: () => set({ aboutAll: false, listening: false, banner: null, messages: [] }),
}));
