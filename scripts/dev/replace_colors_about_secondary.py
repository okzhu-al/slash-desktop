import re

file_path = '/Users/junior/Projects/slash/apps/desktop/src/features/settings/AboutTab.tsx'

with open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# Replace light mode zinc-500/zinc-400 text with #545454
content = re.sub(r'(?<!dark:)text-zinc-500', r'text-[#545454]', content)
content = re.sub(r'(?<!dark:)text-zinc-400', r'text-[#545454]', content)

# Replace dark mode zinc-500/zinc-400 text with #C8C8C8
content = re.sub(r'dark:text-zinc-500', r'dark:text-[#C8C8C8]', content)
content = re.sub(r'dark:text-zinc-400', r'dark:text-[#C8C8C8]', content)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Replaced secondary text colors in AboutTab.tsx")
