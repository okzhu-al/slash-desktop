const fs = require('fs');
const path = './src/features/sidebar/Sidebar.tsx';
let content = fs.readFileSync(path, 'utf8');

const targetStr = `            // 🌩️ 服务端最终裁决：若为团队目录，正式通知云端实施物理拔除和兵权褫夺
            if (isTeamDirToDelete && targetRemotePath && currentTeamVaultId && config) {
                let toastId;
                try {
                    const { teamService } = await import('@/services/TeamService');
                    toastId = toast.loading(t('team.deleting_dir', '正在粉碎云端目录...'));
                    await teamService.deleteDirectory(config.serverUrl, config.accessToken, currentTeamVaultId, targetRemotePath);
                    toast.dismiss(toastId);
                    console.log(\`[Sidebar] Server directory successfully destroyed: \${targetRemotePath}\`);

                    // 🧹 本地幽灵拔除：若是明确配置出的映射目录（promoted），需连根清理 team_path_mappings.json！
                    const vaultRoot = repo?.rootDir;
                    if (vaultRoot && promotedMappings.size > 0) {
                        const newMappings: Record<string, string> = {};
                        let updated = false;
                        for (const [src, tgt] of promotedMappings.entries()) {
                            // 若源路径是即将受斩的路径，或是其子路径，通通抹灭
                            const srcNorm = src.replace(/\\\\/g, '/').replace(/\\/$/, '');
                            const itemNorm = item.path.replace(/\\\\/g, '/').replace(/\\/$/, '');
                            if (srcNorm === itemNorm || srcNorm.startsWith(itemNorm + '/')) {
                                updated = true;
                                console.log(\`[Sidebar] Unmounting team mapping ghost config: \${src}\`);
                            } else {
                                newMappings[src] = tgt;
                            }
                        }
                        if (updated) {
                            try {
                                const { writeTextFile } = await import('@tauri-apps/plugin-fs');
                                const mappingPath = \`\${vaultRoot}/.slash/team_path_mappings.json\`;
                                const data = JSON.stringify({ vault_id: currentTeamVaultId, mappings: newMappings }, null, 2);
                                await writeTextFile(mappingPath, data);
                                setPromotedMappings(new Map(Object.entries(newMappings)));
                                console.log(\`[Sidebar] Local mapping config purged.\`);
                            } catch (e) {
                                console.warn('[Sidebar] Failed to map team_path_mappings', e);
                            }
                        }
                    }
                } catch (e: any) {
                    if (toastId) toast.dismiss(toastId);
                    const { message } = await import('@tauri-apps/plugin-dialog');
                    let errMsg = String(e.message || e);
                    if (errMsg === 'not_owner') {
                        errMsg = t('sidebar.delete_denied_not_owner', '您不是该目录 Owner 无法进行删除操作，如需删除请联系 Owner');
                    } else if (errMsg?.startsWith('has_other:')) {
                        const user = errMsg.split(':')[1];
                        errMsg = t('sidebar.delete_denied_has_other_files', { user, defaultValue: \`该目录已包含他人（\${user}）创建的目录/笔记，请通知作者清理后删除\` });
                    }
                    await message(t('team.delete_failed', { error: errMsg, defaultValue: \`服务端抹除失败: \${errMsg}\` }), { title: t('team.sync_delete_error', "同步删除异常"), kind: 'error' });
                    return; // 🛑 若服务端处决失败，严禁本地继续“自欺欺人”
                }
            }

            // Optimistic update: Remove from UI immediately
            removeNode(item.path);

            if (!isTeamDirToDelete) {
                // 个人笔记：走本地 Trash 流程
                await repo.deleteNote(item.path);

                // 空壳追踪：防止底层 Trash API 对多级目录失效导致留下空架子
                if (item.type === 'folder') {
                    try {
                        const { exists, remove } = await import('@tauri-apps/plugin-fs');
                        if (await exists(item.path)) {
                            await remove(item.path, { recursive: true });
                        }
                    } catch (e) {
                        // ignore empty folder clean fail
                    }
                }
            }`;

const newStr = `            // 🌩️ 服务端最终裁决：若为团队目录，正式通知云端实施物理拔除和兵权褫夺
            if (isTeamDirToDelete && targetRemotePath && currentTeamVaultId && config) {
                let toastId;
                try {
                    const { teamService } = await import('@/services/TeamService');
                    toastId = toast.loading(t('team.deleting_dir', '正在粉碎云端目录...'));
                    await teamService.deleteDirectory(config.serverUrl, config.accessToken, currentTeamVaultId, targetRemotePath);
                    toast.dismiss(toastId);
                    console.log(\`[Sidebar] Server directory successfully destroyed: \${targetRemotePath}\`);

                    // 核心关键：为了防止本地 Sync Engine 发现文件丢失后，擅自向服务器推送 Delete 请求（从而导致服务器产生第二份重影回收站记录），
                    // 同时阻断由于客户端 Push 引起的服务端该目录意外复活（Homesteading），我们必须在此刻亲自剜掉 unified_sync_state.json 中的状态。
                    const vaultRoot = repo?.rootDir;
                    if (vaultRoot) {
                        try {
                            const { readTextFile, writeTextFile } = await import('@tauri-apps/plugin-fs');
                            const statePath = \`\${vaultRoot}/.slash/unified_sync_state.json\`;
                            const stateStr = await readTextFile(statePath);
                            const state = JSON.parse(stateStr);
                            let stateChanged = false;
                            
                            const { getRelativePath } = await import('@/shared/utils/pathUtils');
                            const relPath = getRelativePath(item.path, vaultRoot);
                            const targetPrefix = relPath.replace(/\\\\/g, '/') + '/';
                            const targetExact = relPath.replace(/\\\\/g, '/');

                            for (const key in state) {
                                const normKey = key.replace(/\\\\/g, '/');
                                if (normKey === targetExact || normKey.startsWith(targetPrefix)) {
                                    delete state[key];
                                    stateChanged = true;
                                }
                            }

                            if (stateChanged) {
                                await writeTextFile(statePath, JSON.stringify(state, null, 2));
                                console.log(\`[Sidebar] Extracted deleted subtree '\${targetExact}' from unified_sync_state to prevent sync ghosting.\`);
                            }
                        } catch (e) {
                            console.warn('[Sidebar] Cleanly scrub unified_sync_state failed (non-fatal):', e);
                        }
                    }

                    // 🧹 本地幽灵拔除：若是明确配置出的映射目录（promoted），需连根清理 team_path_mappings.json！
                    if (vaultRoot && promotedMappings.size > 0) {
                        const newMappings: Record<string, string> = {};
                        let updated = false;
                        for (const [src, tgt] of promotedMappings.entries()) {
                            // 若源路径是即将受斩的路径，或是其子路径，通通抹灭
                            const srcNorm = src.replace(/\\\\/g, '/').replace(/\\/$/, '');
                            const itemNorm = item.path.replace(/\\\\/g, '/').replace(/\\/$/, '');
                            if (srcNorm === itemNorm || srcNorm.startsWith(itemNorm + '/')) {
                                updated = true;
                                console.log(\`[Sidebar] Unmounting team mapping ghost config: \${src}\`);
                            } else {
                                newMappings[src] = tgt;
                            }
                        }
                        if (updated) {
                            try {
                                const { writeTextFile } = await import('@tauri-apps/plugin-fs');
                                const mappingPath = \`\${vaultRoot}/.slash/team_path_mappings.json\`;
                                const data = JSON.stringify({ vault_id: currentTeamVaultId, mappings: newMappings }, null, 2);
                                await writeTextFile(mappingPath, data);
                                setPromotedMappings(new Map(Object.entries(newMappings)));
                                console.log(\`[Sidebar] Local mapping config purged.\`);
                            } catch (e) {
                                console.warn('[Sidebar] Failed to map team_path_mappings', e);
                            }
                        }
                    }
                } catch (e: any) {
                    if (toastId) toast.dismiss(toastId);
                    const { message } = await import('@tauri-apps/plugin-dialog');
                    let errMsg = String(e.message || e);
                    if (errMsg === 'not_owner') {
                        errMsg = t('sidebar.delete_denied_not_owner', '您不是该目录 Owner 无法进行删除操作，如需删除请联系 Owner');
                    } else if (errMsg?.startsWith('has_other:')) {
                        const user = errMsg.split(':')[1];
                        errMsg = t('sidebar.delete_denied_has_other_files', { user, defaultValue: \`该目录已包含他人（\${user}）创建的目录/笔记，请通知作者清理后删除\` });
                    }
                    await message(t('team.delete_failed', { error: errMsg, defaultValue: \`服务端抹除失败: \${errMsg}\` }), { title: t('team.sync_delete_error', "同步删除异常"), kind: 'error' });
                    return; // 🛑 若服务端处决失败，严禁本地继续“自欺欺人”
                }
            }

            // Optimistic update: Remove from UI immediately
            removeNode(item.path);

            // 本地物理拔除：统一执行本地 Trash 流程
            await repo.deleteNote(item.path);

            // 空壳追踪：防止底层 Trash API 对多级目录失效导致留下空架子
            if (item.type === 'folder') {
                try {
                    const { exists, remove } = await import('@tauri-apps/plugin-fs');
                    if (await exists(item.path)) {
                        await remove(item.path, { recursive: true });
                    }
                } catch (e) {
                    // Ignore gracefully - it means OS level locking might be present
                }
            }`;

if (content.indexOf(targetStr) !== -1) {
    fs.writeFileSync(path, content.replace(targetStr, newStr));
    console.log("Replaced successfully");
} else {
    console.error("Target string not found in Sidebar.tsx");
}
