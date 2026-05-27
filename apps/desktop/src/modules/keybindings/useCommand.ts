import { useEffect } from 'react';
import { useKeybindingContext } from './KeybindingProvider';
import { CommandHandler } from './types';

export const useCommand = (commandId: string, handler: CommandHandler) => {
    const { registerHandler } = useKeybindingContext();

    useEffect(() => {
        const unregister = registerHandler(commandId, handler);
        return unregister;
    }, [commandId, handler, registerHandler]);
};
