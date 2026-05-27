import re

file_path = "apps/desktop/src/features/team/TeamManagePage.tsx"

with open(file_path, "r") as f:
    content = f.read()

# 1. indigo / green / blue -> #006540
content = re.sub(r'(bg|text|border|ring|fill|stroke)-(indigo|green|blue)-[0-9]+', r'\1-[#006540]', content)

# 2. amber -> #EFE0CC
content = re.sub(r'(bg|text|border|ring|fill|stroke)-amber-[0-9]+', r'\1-[#EFE0CC]', content)

# 3. red -> #FED6B8
content = re.sub(r'(bg|text|border|ring|fill|stroke)-red-[0-9]+', r'\1-[#FED6B8]', content)

# 4. zinc (gray) mappings based on context:
# Secondary text: text-zinc-400, text-zinc-500 -> text-[#C8C8C8]
content = re.sub(r'text-zinc-[45]00', r'text-[#C8C8C8]', content)
# Borders: border-zinc-200, border-zinc-300 -> border-[#C8C8C8]
content = re.sub(r'border-zinc-[23]00', r'border-[#C8C8C8]', content)
# Light backgrounds: bg-zinc-50, bg-zinc-100, bg-zinc-200 -> bg-[#C8C8C8]/10 or similar
content = re.sub(r'bg-zinc-50\b', r'bg-[#C8C8C8]/10', content)
content = re.sub(r'bg-zinc-100\b', r'bg-[#C8C8C8]/20', content)
content = re.sub(r'bg-zinc-200\b', r'bg-[#C8C8C8]/30', content)

with open(file_path, "w") as f:
    f.write(content)

print("Done")
