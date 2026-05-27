import os
import re
import glob

directory = "apps/desktop/src/features/settings/sync/steps/*.tsx"

for file_path in glob.glob(directory):
    with open(file_path, "r") as f:
        content = f.read()

    # Blue (Klein Blue #002FA7)
    content = re.sub(r'bg-indigo-[0-9]+(/[0-9]+)?', r'bg-[#002FA7]\1', content)
    content = re.sub(r'text-indigo-[0-9]+(/[0-9]+)?', r'text-[#002FA7]\1', content)
    content = re.sub(r'border-indigo-[0-9]+(/[0-9]+)?', r'border-[#002FA7]\1', content)
    content = re.sub(r'ring-indigo-[0-9]+(/[0-9]+)?', r'ring-[#002FA7]\1', content)
    content = re.sub(r'from-indigo-[0-9]+(/[0-9]+)?', r'from-[#002FA7]\1', content)
    content = re.sub(r'to-indigo-[0-9]+(/[0-9]+)?', r'to-[#002FA7]\1', content)
    
    # Red (Cartier Red #A42227)
    content = re.sub(r'bg-red-[0-9]+(/[0-9]+)?', r'bg-[#A42227]\1', content)
    content = re.sub(r'text-red-[0-9]+(/[0-9]+)?', r'text-[#A42227]\1', content)
    content = re.sub(r'border-red-[0-9]+(/[0-9]+)?', r'border-[#A42227]\1', content)
    content = re.sub(r'ring-red-[0-9]+(/[0-9]+)?', r'ring-[#A42227]\1', content)
    
    # Green (Sea Blue-Green #006540)
    content = re.sub(r'bg-green-[0-9]+(/[0-9]+)?', r'bg-[#006540]\1', content)
    content = re.sub(r'text-green-[0-9]+(/[0-9]+)?', r'text-[#006540]\1', content)
    content = re.sub(r'border-green-[0-9]+(/[0-9]+)?', r'border-[#006540]\1', content)
    content = re.sub(r'ring-green-[0-9]+(/[0-9]+)?', r'ring-[#006540]\1', content)

    content = re.sub(r'bg-emerald-[0-9]+(/[0-9]+)?', r'bg-[#006540]\1', content)
    content = re.sub(r'text-emerald-[0-9]+(/[0-9]+)?', r'text-[#006540]\1', content)
    content = re.sub(r'border-emerald-[0-9]+(/[0-9]+)?', r'border-[#006540]\1', content)

    # Secondary Text - Two-pass to handle dark and light correctly
    content = re.sub(r'dark:text-zinc-[3456]00', r'dark:text-[#C8C8C8]', content)
    content = re.sub(r'text-zinc-[456]00', r'text-[#545454]', content)
    
    with open(file_path, "w") as f:
        f.write(content)

print("Applied brand colors to all sync step files.")
