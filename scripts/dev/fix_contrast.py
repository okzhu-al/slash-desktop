import re

file_path = "apps/desktop/src/features/team/StorageDashboard.tsx"

with open(file_path, "r") as f:
    content = f.read()

# 1. Fix Snapshots text readability. #EFE0CC is too light for text.
# Replace text-[#EFE0CC] with text-[#B38F5A]
content = content.replace("text-[#EFE0CC]", "text-[#B38F5A]")
# But keep bg-[#EFE0CC] and border-[#EFE0CC] as they are fine.

# 2. Fix Cartier Red text readability. #FED6B8 is too light for text.
# Replace text-[#FED6B8] with text-[#C44D29]
content = content.replace("text-[#FED6B8]", "text-[#C44D29]")

# 3. Make BOTH delete buttons use Cartier Red.
# The user wants "两个删除按钮的颜色使用卡地亚红色".
# Delete button 1 (Trash): already Cartier red background (bg-[#FED6B8]), but let's improve contrast.
content = content.replace(
    'bg-[#FED6B8] hover:bg-[#FED6B8] dark:bg-[#FED6B8]/20 dark:hover:bg-[#FED6B8]/40 text-[#C44D29] dark:text-[#C44D29]',
    'bg-[#FED6B8]/40 hover:bg-[#FED6B8]/60 dark:bg-[#FED6B8]/20 dark:hover:bg-[#FED6B8]/40 text-[#C44D29] dark:text-[#FED6B8]'
)
# Delete button 2 (Snapshots inside Card C): Change from EFE0CC to FED6B8
content = content.replace(
    'bg-[#EFE0CC] hover:bg-[#EFE0CC] dark:bg-[#EFE0CC]/20 dark:hover:bg-[#EFE0CC]/40 text-[#B38F5A] dark:text-[#B38F5A]',
    'bg-[#FED6B8]/40 hover:bg-[#FED6B8]/60 dark:bg-[#FED6B8]/20 dark:hover:bg-[#FED6B8]/40 text-[#C44D29] dark:text-[#FED6B8]'
)
# Delete button 3 (Legacy):
content = content.replace(
    'bg-[#FED6B8] hover:bg-[#FED6B8] dark:bg-[#FED6B8]/30 dark:hover:bg-[#FED6B8]/50 text-[#C44D29] dark:text-[#C44D29]',
    'bg-[#FED6B8]/40 hover:bg-[#FED6B8]/60 dark:bg-[#FED6B8]/30 dark:hover:bg-[#FED6B8]/50 text-[#C44D29] dark:text-[#FED6B8]'
)

# 4. Fix Modal Buttons
# The confirm buttons in the modal also suffer from the same bg==text issue because my previous script replaced them.
# 'bg-[#EFE0CC] hover:bg-[#EFE0CC] shadow-[#EFE0CC]/20'
content = content.replace(
    "target === 'snapshots' ? 'bg-[#EFE0CC] hover:bg-[#EFE0CC] shadow-[#EFE0CC]/20'\n                                : target === 'trash' ? 'bg-[#FED6B8] hover:bg-[#FED6B8] shadow-[#FED6B8]/20'\n                                    : 'bg-[#FED6B8] hover:bg-[#FED6B8] shadow-[#FED6B8]/20'",
    "target === 'snapshots' ? 'bg-[#FED6B8] hover:brightness-95 shadow-[#FED6B8]/20 text-[#C44D29]'\n                                : target === 'trash' ? 'bg-[#FED6B8] hover:brightness-95 shadow-[#FED6B8]/20 text-[#C44D29]'\n                                    : 'bg-[#FED6B8] hover:brightness-95 shadow-[#FED6B8]/20 text-[#C44D29]'"
)

# Let's ensure text-white in the modal button doesn't conflict with text-[#C44D29]
content = content.replace(
    '"px-6 py-2 text-sm font-bold text-white rounded-lg transition-all cursor-pointer shadow-md",',
    '"px-6 py-2 text-sm font-bold rounded-lg transition-all cursor-pointer shadow-md",'
)

with open(file_path, "w") as f:
    f.write(content)

print("Text readability adjustments complete")
