import re

file_path = "apps/desktop/src/features/team/StorageDashboard.tsx"

with open(file_path, "r") as f:
    content = f.read()

# Fix solid backgrounds that should be soft
content = content.replace("bg-[#A42227] dark:bg-[#A42227]/10", "bg-[#A42227]/10 dark:bg-[#A42227]/10")

with open(file_path, "w") as f:
    f.write(content)

print("Fixed solid backgrounds")
