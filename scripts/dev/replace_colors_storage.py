import re

file_path = "apps/desktop/src/features/team/StorageDashboard.tsx"

with open(file_path, "r") as f:
    content = f.read()

# 1. Personal Space (Green) -> #006540
# Original uses emerald
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-emerald-[0-9]+', r'\1-[#006540]', content)

# 2. Snapshots (Yellow) -> #EFE0CC
# Original uses amber and yellow
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-amber-[0-9]+', r'\1-[#EFE0CC]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-yellow-[0-9]+', r'\1-[#EFE0CC]', content)

# 3. Legacy / Trash (Red) -> #FED6B8
# Original uses rose, orange, red
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-rose-[0-9]+', r'\1-[#FED6B8]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-orange-[0-9]+', r'\1-[#FED6B8]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-red-[0-9]+', r'\1-[#FED6B8]', content)

with open(file_path, "w") as f:
    f.write(content)

print("Replacement complete")
