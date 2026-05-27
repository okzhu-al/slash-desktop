import re

files = [
    "apps/desktop/src/features/team/StorageDashboard.tsx",
    "apps/desktop/src/features/team/TeamManagePage.tsx"
]

for file_path in files:
    with open(file_path, "r") as f:
        content = f.read()

    # The old fake Cartier Red
    old_red = "#FED6B8"
    # The dark text variant I made for the fake Cartier Red
    dark_red = "#C44D29"
    # The real Cartier Red
    real_red = "#A42227"

    # Replace the dark variant with real red
    content = content.replace(dark_red, real_red)

    # For the solid confirm buttons in the modal:
    # "bg-[#FED6B8] hover:brightness-95 shadow-[#FED6B8]/20 text-[#C44D29]" -> "bg-[#A42227] hover:brightness-95 shadow-[#A42227]/20 text-white"
    # Since I already replaced dark_red with real_red above:
    content = content.replace(
        f"bg-[{old_red}] hover:brightness-95 shadow-[{old_red}]/20 text-[{real_red}]",
        f"bg-[{real_red}] hover:brightness-95 shadow-[{real_red}]/20 text-white"
    )

    # For delete buttons that were: bg-[#FED6B8]/40 ... text-[#A42227]
    # Let's make them elegant hollow buttons: bg-[#A42227]/10 hover:bg-[#A42227]/20 text-[#A42227]
    content = content.replace(f"bg-[{old_red}]/40 hover:bg-[{old_red}]/60 dark:bg-[{old_red}]/20 dark:hover:bg-[{old_red}]/40 text-[{real_red}] dark:text-[{old_red}]", 
                              f"bg-[{real_red}]/10 hover:bg-[{real_red}]/20 dark:bg-[{real_red}]/20 dark:hover:bg-[{real_red}]/30 text-[{real_red}] dark:text-[{real_red}]")
    content = content.replace(f"bg-[{old_red}]/40 hover:bg-[{old_red}]/60 dark:bg-[{old_red}]/30 dark:hover:bg-[{old_red}]/50 text-[{real_red}] dark:text-[{old_red}]", 
                              f"bg-[{real_red}]/10 hover:bg-[{real_red}]/20 dark:bg-[{real_red}]/20 dark:hover:bg-[{real_red}]/30 text-[{real_red}] dark:text-[{real_red}]")

    # For the alert box bg-[#FED6B8]/30 -> bg-[#A42227]/10
    content = content.replace(f"bg-[{old_red}]/30", f"bg-[{real_red}]/10")

    # Replace all remaining instances of old_red with real_red
    content = content.replace(old_red, real_red)

    with open(file_path, "w") as f:
        f.write(content)

print("Cartier Red values successfully corrected to #A42227")
