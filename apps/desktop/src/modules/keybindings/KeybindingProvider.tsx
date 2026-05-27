import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { COMMANDS } from './registry';
import { CommandHandler, CommandRegistry, Scope } from './types';
import { useKeybindingsStore } from './KeybindingsStore';

interface KeybindingContextType {
    registerHandler: (id: string, handler: CommandHandler) => () => void;
    setScope: (scope: Scope, isActive: boolean) => void;
    activeScopes: Set<Scope>;
    registry: CommandRegistry;
}

const KeybindingContext = createContext<KeybindingContextType | null>(null);

// Helper to normalize key strings (e.g. "Meta" -> "Mod")
const normalizeKey = (e: KeyboardEvent): string => {
    const parts = [];
    if (e.metaKey || e.ctrlKey) parts.push("Mod");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");

    // keys like "b" or "Enter"
    // We want uppercase for letters to match "Mod+B"
    let key = e.key.toUpperCase();
    if (key === "CONTROL" || key === "META" || key === "ALT" || key === "SHIFT") return ""; // Ignore modifier only presses

    parts.push(key);
    return parts.join("+");
};

export const KeybindingProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Current active scopes
    const [activeScopes, setActiveScopes] = useState<Set<Scope>>(new Set(['global']));

    // Subscribe to customKeys directly for reactive updates
    const customKeys = useKeybindingsStore(state => state.customKeys);

    // Handlers: commandId -> handlers[]
    // We use a ref so the event listener always accesses the latest without re-binding
    const handlersRef = useRef<Map<string, CommandHandler[]>>(new Map());

    const registerHandler = (id: string, handler: CommandHandler) => {
        const currentHandlers = handlersRef.current.get(id) || [];
        handlersRef.current.set(id, [...currentHandlers, handler]);

        return () => {
            const handlers = handlersRef.current.get(id) || [];
            handlersRef.current.set(id, handlers.filter(h => h !== handler));
        };
    };

    const setScope = (scope: Scope, isActive: boolean) => {
        setActiveScopes(prev => {
            const next = new Set(prev);
            if (isActive) next.add(scope);
            else next.delete(scope);
            return next;
        });
    };

    // We need current activeScopes in the event listener. 
    // Since we don't want to re-bind listener on scope change, use a ref.
    const activeScopesRef = useRef(activeScopes);
    useEffect(() => {
        activeScopesRef.current = activeScopes;
    }, [activeScopes]);

    // Use ref for customKeys to always access latest in event handler
    const customKeysRef = useRef(customKeys);
    useEffect(() => {
        customKeysRef.current = customKeys;
    }, [customKeys]);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const combo = normalizeKey(e);
            if (!combo) return;

            // Find command that matches this combo (using effective keys)
            const matchedCommand = Object.values(COMMANDS).find(cmd => {
                const command = COMMANDS[cmd.id];
                if (!command) return false;
                const effectiveKey = customKeysRef.current[cmd.id] || command.defaultKey;
                return effectiveKey === combo;
            });

            if (!matchedCommand) return;

            // Check Scope
            if (!activeScopesRef.current.has(matchedCommand.scope)) {
                return;
            }

            // Execute Handler
            const handlers = handlersRef.current.get(matchedCommand.id);
            if (handlers && handlers.length > 0) {
                e.preventDefault();
                handlers.forEach(h => h());
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    return (
        <KeybindingContext.Provider value={{ registerHandler, setScope, activeScopes, registry: COMMANDS }}>
            {children}
        </KeybindingContext.Provider>
    );
};

export const useKeybindingContext = () => {
    const context = useContext(KeybindingContext);
    if (!context) throw new Error("useKeybindingContext must be used within KeybindingProvider");
    return context;
};
