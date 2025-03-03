from websocket import WebSocketApp
import json
import qrcode
import sys
from datetime import datetime
import pytz


class WSAppClient:
    def __init__(self, server_url):
        self.server_url = server_url
        self.user_id = None
        self.ws = None  # WebSocket instance
        self.groups = []  # Store fetched groups
        self.waiting_for_messages = False  # Flag to keep waiting for messages when option 1 is selected

    def on_open(self, ws):
        """Handles WebSocket connection open event."""
        print("✅ Connected to the server.")
        self.ws = ws  # Store the WebSocket instance

        default_user_id = "0547778005"
        self.user_id = input(f"Enter your user ID (default: {default_user_id}): ") or default_user_id

        if self.user_id:
            initiate_request = {
                "user_id": self.user_id,
                "event": "initiate"
            }
            ws.send(json.dumps(initiate_request))
            print(f"📤 Sent initiate request: {initiate_request}")
        else:
            print("❌ User ID cannot be empty.")
            ws.close()

    def on_message(self, ws, message):
        """Handles incoming messages from the WebSocket server."""
        try:
            data = json.loads(message)
            event = data.get("event", "UNKNOWN_EVENT")
            event_data = data.get("data", data)  # Fallback to full data if "data" key is missing

            print(f"\n📩 Message received from server:")
            print(f"🔹 Event: {event}")

            if event == "qr":
                qr_code_data = data.get("qr_code")
                if qr_code_data:
                    print("\n🔹 QR Code Received! Scan it to connect WhatsApp.")
                    self.display_qr_code(qr_code_data)

            elif event == "ready":
                print("✅ WhatsApp client is ready!")
                self.prompt_user_action()

            elif event == "group_list":
                self.groups = event_data.get("groups", []) if isinstance(event_data, dict) else []
                self.display_groups(self.groups)
                self.prompt_user_action()

            elif event == "group_messages":
                self.display_group_messages(event_data)
                self.prompt_user_action()

            elif event == "message":
                message = data.get("message")
                self.display_message(message)
                self.prompt_user_action()

            elif event == "message_sent":
                print(f"✅ Message sent successfully to {event_data.get('recipientId', 'Unknown')}.")
                self.prompt_user_action()

            elif event == "disconnected":
                print("✅ Disconnected from the server. Exiting...")
                ws.close()
                exit(0)

            else:
                print(f"🔹 Data: {json.dumps(event_data, indent=2)[:100]}...")  # Truncated for readability

        except json.JSONDecodeError:
            print("❌ Received non-JSON message:", message)

    def prompt_user_action(self):
        """Prompt the user to choose an action."""
        print("\n📌 Choose an action:")
        print("1️⃣ Get Messages (Wait for new messages)")
        print("2️⃣ Fetch Groups")
        print("3️⃣ Fetch Messages from a Group")
        print("4️⃣ Send a Message")
        print("5️⃣ Disconnect")

        choice = input("Enter your choice (1-5): ").strip()
        if choice == "1":
            self.waiting_for_messages = True  # Keep waiting for new messages
            self.request_messages()
        elif choice == "2":
            self.request_groups()
        elif choice == "3":
            self.request_group_messages()
        elif choice == "4":
            self.send_message()
        elif choice == "5":
            self.request_disconnect()
        else:
            print("❌ Invalid choice. Please try again.")
            self.prompt_user_action()

    def request_groups(self):
        """Sends a request to fetch the user's WhatsApp groups."""
        if self.ws and self.user_id:
            group_request = {
                "user_id": self.user_id,
                "event": "get_groups"
            }
            self.ws.send(json.dumps(group_request))
            print("📤 Requesting WhatsApp groups...")

    def request_messages(self):
        """Sends a request to fetch the user's WhatsApp groups."""
        if self.ws and self.user_id:
            group_request = {
                "user_id": self.user_id,
                "event": "get_messages"
            }
            self.ws.send(json.dumps(group_request))
            print("📤 Requesting WhatsApp messages...")

    def request_group_messages(self):
        """Prompts user to select a group and request messages."""
        if not self.groups:
            print("❌ No groups found. Fetch groups first.")
            self.request_groups()
            return

        print("\n📌 Select a group to fetch messages:")
        for i, group in enumerate(self.groups, start=1):
            print(f"{i}. {group.get('name', 'Unknown')} (ID: {group.get('id', 'N/A')})")

        choice = input("Enter group number: ").strip()
        try:
            choice = int(choice) - 1
            if 0 <= choice < len(self.groups):
                group_id = self.groups[choice]["id"]
                start_time = input("Enter start time (YYYY-MM-DD HH:MM:SS) or leave empty for recent messages: ").strip()
                end_time = input("Enter end time (YYYY-MM-DD HH:MM:SS) or leave empty: ").strip()

                request_payload = {
                    "user_id": self.user_id,
                    "event": "get_group_messages",
                    "group_id": group_id
                }

                if start_time:
                    request_payload["startTime"] = start_time
                if end_time:
                    request_payload["endTime"] = end_time

                self.ws.send(json.dumps(request_payload))
                print(f"📤 Requesting messages from group {group_id}...")
            else:
                print("❌ Invalid group selection.")
        except ValueError:
            print("❌ Please enter a valid number.")

    def send_message(self):
        """Prompts user to enter message details and sends it."""
        recipient = input("Enter recipient (group ID or phone number): ").strip()
        if not recipient:
            print("❌ Recipient cannot be empty.")
            return

        message = input("Enter your message: ").strip()
        if not message:
            print("❌ Message cannot be empty.")
            return

        message_request = {
            "user_id": self.user_id,
            "event": "send_message",
            "recipient": recipient,
            "message": message
        }
        self.ws.send(json.dumps(message_request))
        print(f"📤 Sending message to {recipient}...")

    def request_disconnect(self):
        """Sends a request to disconnect."""
        if self.ws and self.user_id:
            disconnect_request = {
                "user_id": self.user_id,
                "event": "disconnect"
            }
            self.ws.send(json.dumps(disconnect_request))
            print("📤 Sent disconnect request.")

    def display_group_messages(self, data):
        """Displays messages from a WhatsApp group."""
        print("\n📥 Group Messages:")
        messages = data.get("messages", [])
        if messages:
            for msg in messages:
                timestamp = datetime.fromtimestamp(msg["timestamp"] / 1000).strftime('%Y-%m-%d %H:%M:%S')
                sender = msg.get("sender", "Unknown Sender")
                body = msg.get("body", "No Content")
                print(f"📆 [{timestamp}] 👤 {sender}: {body}")
        else:
            print("❌ No messages found.")

    def display_message(self, data):
        """Displays messages from a WhatsApp group."""
        print("\n📥 message:")
        
        timestamp = datetime.fromtimestamp(data["timestamp"] / 1000).strftime('%Y-%m-%d %H:%M:%S')
        sender = data.get("sender", "Unknown Sender")
        body = data.get("body", "No Content")
        print(f"📆 [{timestamp}] 👤 {sender}: {body}")
        

    def display_groups(self, groups):
        """Displays the fetched WhatsApp groups."""
        print("\n📂 WhatsApp Groups List:")
        if groups:
            for i, group in enumerate(groups, start=1):
                print(f"  {i}. {group.get('name', 'Unknown')} (ID: {group.get('id', 'N/A')})")
        else:
            print("  ❌ No groups found.")

    def display_qr_code(self, qr_code_data):
        """Generates and displays the QR code."""
        qr = qrcode.QRCode(box_size=2, border=1)  # Reduce box_size to shrink the QR code
        qr.add_data(qr_code_data)
        qr.make(fit=True)
        print("\n📷 Scan the QR code above using WhatsApp.")
        qr.print_ascii()

    def run(self):
        """Starts the WebSocket client."""
        ws = WebSocketApp(self.server_url, on_open=self.on_open, on_message=self.on_message)
        self.ws = ws
        ws.run_forever()


if __name__ == "__main__":
    client = WSAppClient("ws://localhost:3000")
    client.run()
