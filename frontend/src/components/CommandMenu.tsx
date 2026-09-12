"use client";

import { IconFileText, IconMessageChatbot, IconSettings, IconCrown, IconBell } from "@tabler/icons-react";
import { Command } from "cmdk";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { DocumentOut } from "@/lib/api";

export function CommandMenu({
  documents,
  onSelectDocument,
}: {
  documents: DocumentOut[];
  onSelectDocument: (id: string | null) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function go(path: string) {
    setOpen(false);
    router.push(path);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="lx-btn lx-btn-sm lx-btn-ghost lx-cmd-trigger"
        aria-label="Open command menu"
      >
        <IconMessageChatbot size={15} />
        <span>Ask, jump, act…</span>
        <span className="lx-kbd">⌘K</span>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 1060,
              background: "rgb(16 24 40 / 0.45)",
              display: "flex",
              justifyContent: "center",
              paddingTop: "14vh",
            }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ duration: 0.2, ease: [0.23, 1, 0.32, 1] }}
              onClick={(e) => e.stopPropagation()}
              style={{ width: "min(560px, 92vw)", height: "fit-content" }}
            >
              <Command
                label="Command menu"
                className="lx-card"
                style={{ overflow: "hidden", boxShadow: "var(--shadow-2)" }}
              >
                <Command.Input
                  placeholder="Ask, jump to a document, or act…"
                  className="lx-input"
                  style={{ border: 0, borderRadius: 0, padding: "0.9rem 1.1rem", fontSize: 15, boxShadow: "none" }}
                />
                <Command.List
                  className="chat-scroll"
                  style={{ maxHeight: 320, overflowY: "auto", padding: "0.5rem" }}
                >
                  <Command.Empty style={{ color: "var(--ink-2)", padding: "0.8rem 1.1rem" }}>No matches.</Command.Empty>
                  <Command.Group heading="Go to">
                    <Command.Item
                      onSelect={() => go("/chat")}
                      className="lx-cmd-item"
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem", cursor: "pointer", fontSize: "0.88rem" }}
                    >
                      <IconMessageChatbot size={16} /> New conversation
                    </Command.Item>
                    <Command.Item
                      onSelect={() => go("/notifications")}
                      className="lx-cmd-item"
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem", cursor: "pointer", fontSize: "0.88rem" }}
                    >
                      <IconBell size={16} /> Notifications
                    </Command.Item>
                    <Command.Item
                      onSelect={() => go("/pricing")}
                      className="lx-cmd-item"
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem", cursor: "pointer", fontSize: "0.88rem" }}
                    >
                      <IconCrown size={16} /> Pricing
                    </Command.Item>
                    <Command.Item
                      onSelect={() => go("/settings")}
                      className="lx-cmd-item"
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem", cursor: "pointer", fontSize: "0.88rem" }}
                    >
                      <IconSettings size={16} /> Settings & privacy
                    </Command.Item>
                  </Command.Group>
                  {documents.length > 0 ? (
                    <Command.Group heading="Scope chat to">
                      <Command.Item
                        onSelect={() => {
                          onSelectDocument(null);
                          setOpen(false);
                        }}
                        className="lx-cmd-item"
                        style={{ padding: "0.5rem", cursor: "pointer", fontSize: "0.88rem" }}
                      >
                        All documents
                      </Command.Item>
                      {documents.map((d) => (
                        <Command.Item
                          key={d.id}
                          value={`${d.filename} ${d.id}`}
                          onSelect={() => {
                            onSelectDocument(d.id);
                            setOpen(false);
                          }}
                          className="lx-cmd-item"
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.5rem", cursor: "pointer", fontSize: "0.88rem" }}
                        >
                          <IconFileText size={16} />
                          <span className="text-truncate">{d.filename}</span>
                        </Command.Item>
                      ))}
                    </Command.Group>
                  ) : null}
                </Command.List>
              </Command>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
