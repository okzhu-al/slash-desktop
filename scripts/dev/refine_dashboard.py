import re

file_path = "apps/desktop/src/features/team/StorageDashboard.tsx"

with open(file_path, "r") as f:
    content = f.read()

# 1. Update Secondary Texts to #545454
# Replace text-[#C8C8C8] with text-[#545454]
content = content.replace("text-[#C8C8C8]", "text-[#545454]")
# Replace remaining text-zinc-400, 500, 600, 700 with text-[#545454] for secondary text.
# Be careful not to replace text-zinc-800 or 900 which are primary black.
content = re.sub(r'text-zinc-[456]00', r'text-[#545454]', content)

# 2. Update Card Titles and Borders
# Card A
# Original: <h3 className="font-semibold text-zinc-800 dark:text-zinc-200">A. {t('team.storage_team_space')}</h3>
content = content.replace(
    '<h3 className="font-semibold text-zinc-800 dark:text-zinc-200">A. {t(\'team.storage_team_space\')}</h3>',
    '<h3 className="font-semibold text-[#002FA7] dark:text-[#002FA7]">A. {t(\'team.storage_team_space\')}</h3>'
)
# Original border: <div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-blue-500 shadow-sm flex flex-col">
content = content.replace(
    '<div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-blue-500 shadow-sm flex flex-col">',
    '<div className="rounded-xl border border-[#002FA7] p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 shadow-sm flex flex-col">'
)
# Wait, border-t-blue-500 was replaced by my previous script to border-t-[#002FA7]!
content = content.replace(
    '<div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#002FA7] shadow-sm flex flex-col">',
    '<div className="rounded-xl border border-[#002FA7]/30 dark:border-[#002FA7]/50 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#002FA7] shadow-sm flex flex-col">'
)


# Card B
content = content.replace(
    '<h3 className="font-semibold text-zinc-800 dark:text-zinc-200">B. {t(\'team.storage_personal_backup\')}</h3>',
    '<h3 className="font-semibold text-[#006540] dark:text-[#006540]">B. {t(\'team.storage_personal_backup\')}</h3>'
)
content = content.replace(
    '<div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#006540] shadow-sm flex flex-col">',
    '<div className="rounded-xl border border-[#006540]/30 dark:border-[#006540]/50 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#006540] shadow-sm flex flex-col">'
)

# Card C
content = content.replace(
    '<h3 className="font-semibold text-zinc-800 dark:text-zinc-200">C. {t(\'team.storage_snapshots_legacy\')}</h3>',
    '<h3 className="font-semibold text-[#EFE0CC] dark:text-[#EFE0CC]">C. {t(\'team.storage_snapshots_legacy\')}</h3>'
)
content = content.replace(
    '<div className="rounded-xl border border-[#C8C8C8] dark:border-zinc-800 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#EFE0CC] shadow-sm flex flex-col">',
    '<div className="rounded-xl border border-[#EFE0CC]/50 dark:border-[#EFE0CC]/50 p-5 space-y-4 bg-white dark:bg-zinc-900 border-t-4 border-t-[#EFE0CC] shadow-sm flex flex-col">'
)


with open(file_path, "w") as f:
    f.write(content)

print("Replacement complete")
