import { create } from "zustand";
import { api } from "../lib/api";

export type Module = {
  id: string;
  slug: string;
  label: string;
  icon?: string;
  entryCount: number;
};

type ModulesState = {
  modules: Module[];
  loading: boolean;
  fetched: boolean;
  fetchModules: () => Promise<void>;
};

export const useModules = create<ModulesState>((set, get) => ({
  modules: [],
  loading: false,
  fetched: false,
  fetchModules: async () => {
    if (get().fetched || get().loading) return;
    set({ loading: true });
    try {
      const mods = await api<Module[]>("/api/v1/modules/with-counts");
      set({ modules: mods, loading: false, fetched: true });
    } catch {
      set({ modules: [], loading: false, fetched: true });
    }
  },
}));
