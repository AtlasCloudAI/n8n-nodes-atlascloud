# N8N Nodes for AtlasCloud

> Power your n8n workflows with Seedance 2.0 and unlock a new standard for AI video creation. Explore the [Seedance 2.0 family](https://www.atlascloud.ai/collections/seedance2?utm_source=github&utm_medium=link&utm_campaign=n8n-nodes-atlascloud) on AtlasCloud.

[AtlasCloud](https://www.atlascloud.ai?utm_source=github&utm_medium=link&utm_campaign=n8n-nodes-atlascloud) is a cloud-based AI platform that provides high-performance model inference services. This n8n community node package allows you to seamlessly integrate AtlasCloud's infrastructure into your workflows, giving you access to popular Large Language Models (LLMs) and advanced Image/Video generation models.

## Features

### 💬 AtlasCloud Chat

A powerful node for interacting with Large Language Models via an OpenAI-compatible interface.

- **Wide Model Support**: Access popular models including Claude, GPT, Gemini, and more.
- **Customizable Prompts**: Support for System Prompts and User Prompts.
- **Advanced Configuration**: Fine-tune generation with parameters like Temperature and Max Tokens.
- **Extra Messages**: Support for passing full conversation history or JSON-structured messages.

### 🚀 AtlasCloud Task Submit

A universal node for submitting AI generation tasks with intelligent parameter adaptation.

- **Dynamic Model Discovery**: Automatically loads available categories (Text-to-Image, Text-to-Video, etc.) and models.
- **Smart Parameter Rendering**: Dynamically renders required and optional parameters based on the selected model's schema.
- **Flexible Execution Modes**:
  - **Submit Only**: Returns the prediction ID immediately for asynchronous processing.
  - **Wait for Completion**: Automatically polls the status and returns the final result once generated.

### 🔍 AtlasCloud Task Status

A dedicated node for managing asynchronous tasks.

- **Status Checking**: Retrieve the current status of any prediction ID.
- **Smart Polling**: "Wait for Completion" mode with configurable polling intervals, timeouts, and retry logic.

## Installation

1. Open your n8n instance and go to **Settings** > **Community Nodes**.
2. Click **Install**.
3. Enter the npm package name: `n8n-nodes-atlascloud`.
4. Wait for the installation to complete and refresh the page.

## Configuration

### Credentials

To use these nodes, you need an API Key from AtlasCloud.

1. [Login to Atlas Cloud](https://console.atlascloud.ai?utm_source=github&utm_medium=link&utm_campaign=n8n-nodes-atlascloud) or [Create an account](https://www.atlascloud.ai/login?utm_source=github&utm_medium=link&utm_campaign=n8n-nodes-atlascloud).
2. Navigate to the **API Keys** page in your settings.
3. Create a new API Key.
4. In n8n, add a new Credential type **Atlas Cloud API** and paste your API Key.

### Usage Guide

#### Image & Video Generation

1. Add the **AtlasCloud Task Submit** node.
2. Select a **Category** (e.g., `Text-to-Image`).
3. Select a specific **Model**.
4. The node will automatically display the specific parameters for that model.
5. Fill in the **Prompt** and other **Required Parameters**.
6. Choose your **Execution Mode**:
   - Select **Wait for Completion** if you want the file output directly in this step.

#### Text Generation (LLM)

1. Add the **AtlasCloud Chat** node.
2. Select your credential.
3. Choose a **Model** from the dropdown list.
4. Enter your **User Prompt**.
5. (Optional) Set a System Prompt to define the assistant's behavior.

## Example Workflows

### 1. Simple Chatbot

```
Webhook → AtlasCloud Chat → Respond to Webhook
```

### 2. Generate Image and Download

```
Start → AtlasCloud Task Submit (Wait for Completion) → HTTP Request (Download Media)
```

### 3. Asynchronous Video Generation

```
Start → AtlasCloud Task Submit (Submit Only) → Wait Node → AtlasCloud Task Status (Wait for Completion)
```

## Resources

- [AtlasCloud Website](https://www.atlascloud.ai?utm_source=github&utm_medium=link&utm_campaign=n8n-nodes-atlascloud)
- [Model Library](https://www.atlascloud.ai/models?utm_source=github&utm_medium=link&utm_campaign=n8n-nodes-atlascloud)
- [Console](https://console.atlascloud.ai?utm_source=github&utm_medium=link&utm_campaign=n8n-nodes-atlascloud)

## License

MIT
