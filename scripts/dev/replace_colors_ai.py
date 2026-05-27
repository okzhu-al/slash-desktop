import os
import re

file_path = '/Users/junior/Projects/slash/apps/desktop/src/features/settings/AITab.tsx'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# For dark mode, dark:text-[#C8C8C8] might stay as #C8C8C8 for contrast, 
# or does the user want it replaced too? 
# "所有淡雅灰的文字要全改为深空灰" -> #545454 is too dark for dark mode?
# Actually, the user's previous request was for the Light mode texts, they explicitly said: 
# "文字使用深空灰[#545454]、线条使用典雅灰[#C8C8C8]"

# Replace text-[#C8C8C8] with text-[#545454]
content = re.sub(r'text-\[#C8C8C8\]', r'text-[#545454]', content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Replaced all text-[#C8C8C8] with text-[#545454] in AITab.tsx")
