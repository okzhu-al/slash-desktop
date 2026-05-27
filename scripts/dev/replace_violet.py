import os
import re
import glob

directory = "apps/desktop/src/features/settings/sync/steps/*.tsx"

for file_path in glob.glob(directory):
    with open(file_path, "r") as f:
        content = f.read()

    # Violet -> Klein Blue #002FA7
    content = re.sub(r'bg-violet-[0-9]+(/[0-9]+)?', r'bg-[#002FA7]\1', content)
    content = re.sub(r'text-violet-[0-9]+(/[0-9]+)?', r'text-[#002FA7]\1', content)
    content = re.sub(r'border-violet-[0-9]+(/[0-9]+)?', r'border-[#002FA7]\1', content)
    content = re.sub(r'ring-violet-[0-9]+(/[0-9]+)?', r'ring-[#002FA7]\1', content)
    content = re.sub(r'from-violet-[0-9]+(/[0-9]+)?', r'from-[#002FA7]\1', content)
    content = re.sub(r'to-violet-[0-9]+(/[0-9]+)?', r'to-[#002FA7]\1', content)

    # Note: bg-[#002FA7] with text-white is already correct where it says bg-violet-600 text-white. 
    # But wait, replace_sync_colors.py already replaced `indigo` with `#002FA7`. Now both Personal and Team will be `#002FA7`. Is that desired? 
    # The user said: "团队是蓝色... 克莱因蓝" and later "我们的蓝色系". So using #002FA7 for everything sync related is fine.

    with open(file_path, "w") as f:
        f.write(content)

print("Replaced violet with Klein Blue.")
