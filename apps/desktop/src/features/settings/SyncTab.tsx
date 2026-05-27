import { Cloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useSyncFlow } from './sync/useSyncFlow';
import { AuthGatewayStep } from './sync/steps/AuthGatewayStep';
import { PairInputStep } from './sync/steps/PairInputStep';
import { SetupPinStep } from './sync/steps/SetupPinStep';
import { CreateTeamStep } from './sync/steps/CreateTeamStep';
import { JoinTeamStep } from './sync/steps/JoinTeamStep';
import { ConnectedPersonalStep } from './sync/steps/ConnectedPersonalStep';
import { ConnectedTeamStep } from './sync/steps/ConnectedTeamStep';
import { ResetAdminStep } from './sync/steps/ResetAdminStep';
import { ChooseModeStep } from './sync/steps/ChooseModeStep';

interface SyncTabProps {
    vaultPath?: string;
    onBlockClose?: (blocked: boolean) => void;
}

export const SyncTab = ({ vaultPath, onBlockClose }: SyncTabProps) => {
    const { t } = useTranslation();
    const ctx = useSyncFlow(vaultPath, onBlockClose);

    const renderStep = () => {
        switch (ctx.step) {
            case 'welcome':             return <AuthGatewayStep ctx={ctx} />;
            case 'pair_input':          return <PairInputStep ctx={ctx} />;
            case 'setup_pin':           return <SetupPinStep ctx={ctx} />;
            case 'create_team':         return <CreateTeamStep ctx={ctx} />;
            case 'join_team':           return <JoinTeamStep ctx={ctx} />;
            case 'connected_personal':  return <ConnectedPersonalStep ctx={ctx} />;
            case 'connected_team':      return <ConnectedTeamStep ctx={ctx} />;
            case 'reset_admin':         return <ResetAdminStep ctx={ctx} />;
            case 'reconnect_personal':  return <AuthGatewayStep ctx={ctx} />;
            case 'reconnect_team':      return <AuthGatewayStep ctx={ctx} />;
            case 'choose_mode':         return <ChooseModeStep ctx={ctx} />;
            default:                    return <AuthGatewayStep ctx={ctx} />;
        }
    };

    return (
        <div className="space-y-6">
            <div>
                <h3 className="text-base font-medium text-zinc-900 dark:text-zinc-100 mb-1 flex items-center gap-2">
                    <Cloud size={16} className="text-[#545454] dark:text-[#C8C8C8]" />
                    {t('sync.title')}
                </h3>
                <p className="text-sm text-[#545454] dark:text-[#C8C8C8] mb-3">
                    {t('sync.desc')}
                </p>
            </div>
            {renderStep()}
        </div>
    );
};
