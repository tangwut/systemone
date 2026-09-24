"""Call the resident model service without printing the API key."""
import argparse
import json
import os
from urllib.request import Request, urlopen

from dotenv import load_dotenv


def main():
    load_dotenv()
    parser = argparse.ArgumentParser()
    parser.add_argument("text", nargs="?", default="我被重复扣款了，请帮我退款。")
    parser.add_argument("--url", default="http://127.0.0.1:8000")
    parser.add_argument("--model", choices=["english", "multilingual", "typed-decisions"])
    args = parser.parse_args()
    payload = {
        "state": {"message": args.text},
        "questions": {
            "refund_requested": {"type": "noul", "instructions": "Does the customer request a refund?"},
            "urgency": {"type": "score", "instructions": "How urgent is the request?",
                        "criteria": ["no time pressure", "needs attention soon", "critical deadline"]},
        },
    }
    if args.model:
        payload["model"] = args.model
    request = Request(args.url.rstrip("/") + "/api/v1/systemone",
                      data=json.dumps(payload).encode(),
                      headers={"Content-Type": "application/json", "Authorization": f"Bearer {os.environ['LAYA_API_KEY']}"})
    with urlopen(request, timeout=120) as response:
        print(json.dumps(json.load(response), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
