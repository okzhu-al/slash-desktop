import re

file_path = "apps/desktop/src/features/team/StorageDashboard.tsx"

with open(file_path, "r") as f:
    content = f.read()

# Blue / Indigo -> Klein Blue
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-blue-[0-9]+', r'\1-[#002FA7]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-indigo-[0-9]+', r'\1-[#002FA7]', content)

# Green / Emerald -> Sea Blue-Green
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-green-[0-9]+', r'\1-[#006540]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-emerald-[0-9]+', r'\1-[#006540]', content)

# Yellow / Amber -> Muted Yellow
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-amber-[0-9]+', r'\1-[#EFE0CC]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-yellow-[0-9]+', r'\1-[#EFE0CC]', content)

# Red / Rose / Orange -> Cartier Red
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-red-[0-9]+', r'\1-[#FED6B8]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-rose-[0-9]+', r'\1-[#FED6B8]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-orange-[0-9]+', r'\1-[#FED6B8]', content)

# Grey -> #C8C8C8 for select secondary text and borders
content = re.sub(r'text-zinc-[45]00', r'text-[#C8C8C8]', content)
content = re.sub(r'border-zinc-[23]00', r'border-[#C8C8C8]', content)

with open(file_path, "w") as f:
    f.write(content)

print("Replacement complete for StorageDashboard.tsx")
