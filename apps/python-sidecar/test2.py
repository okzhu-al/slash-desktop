from markitdown import MarkItDown
from openai import OpenAI
import os

client = OpenAI(base_url="http://localhost:3722", api_key="sk-dummy")
md_with_llm = MarkItDown(llm_client=client, llm_model="gpt-4o", llm_prompt="test")

print("WITH LLM ON PDF:")
try:
    print(md_with_llm.convert("test.pdf").text_content)
except Exception as e:
    print("FAILED:", e)
