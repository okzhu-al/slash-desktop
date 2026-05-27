import re

file_path = "apps/desktop/src/features/team/StorageDashboard.tsx"

with open(file_path, "r") as f:
    content = f.read()

# Blue -> Klein Blue
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-blue-[0-9]+', r'\1-[#002FA7]', content)
content = re.sub(r'(bg|text|border|ring|fill|stroke|shadow)-indigo-[0-9]+', r'\1-[#002FA7]', content)

with open(file_path, "w") as f:
    f.write(content)

print("Replacement complete")
