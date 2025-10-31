# Open WebUI Integration Guide

This guide will walk you through accessing [gpt.hydra.newpaltz.edu](https://gpt.hydra.newpaltz.edu/), creating an account, obtaining your API key, and integrating it with Open WebUI for local LLM access.

## Table of Contents

### Getting Started
- [Accessing Hydra GPT](#accessing-hydra-gpt)
- [Obtaining Your API Key](#obtaining-your-api-key)

### Integration Guide
- [Integrating with Open WebUI](#integrating-with-open-webui)
  - [Configuration Parameters](#configuration-parameters)
  - [Integration Methods](#integration-methods)

### Language-Specific Integration Examples
- [Python Integration](#python-integration)
- [JavaScript/Node.js Integration](#javascriptnodejs-integration)
- [PHP Integration](#php-integration)
- [Java Integration](#java-integration)
- [C# / .NET Integration](#c--net-integration)
- [Ruby Integration](#ruby-integration)
- [Go Integration](#go-integration)
- [Rust Integration](#rust-integration)

### Testing & Troubleshooting
- [Testing Your Connection](#testing-your-connection)
- [Troubleshooting](#troubleshooting)

### Additional Information
- [Security Best Practices](#security-best-practices)
- [Example Use Cases](#example-use-cases)
- [Additional Resources](#additional-resources)
- [Changelog](#changelog)

### System Architecture
- [System Overview](#system-overview)
- [Authentication Flow](#authentication-flow)
- [Student API Access Pattern](#student-api-access-pattern)
- [Network Architecture](#network-architecture)
- [Container Lifecycle Management](#container-lifecycle-management)
- [API Request Flow](#api-request-flow)
- [Student Container Types](#student-container-types)
- [OpenWebUI API Structure](#openwebui-api-structure)
- [Security Architecture](#security-architecture)
- [Data Flow for RAG](#data-flow-for-rag-retrieval-augmented-generation)
- [Deployment Architecture](#deployment-architecture)
- [Troubleshooting Decision Tree](#troubleshooting-decision-tree)
- [Port Reference](#port-reference)
- [Quick Start Workflow](#quick-start-workflow)
- [Summary](#summary)

---

## Accessing Hydra GPT

Hydra GPT is a local LLM platform hosted at SUNY New Paltz. To access it:

1. **Navigate to the platform:**
    - Open your web browser
    - Go to: **https://gpt.hydra.newpaltz.edu** if you have an account already
    - If not, make one on https://hydra.newpaltz.edu/dashboard

---

## Obtaining Your API Key

Once you're logged into **Open WebUI (Hydra GPT)**, you can generate an API key by following these steps:

### Step 1: Navigate to Settings

1. Click your **profile icon** or **username** in the top-right corner.
2. Select **Settings** from the dropdown menu.

### Step 2: Access the API Keys Section

1. In the **Settings** menu, go to the **Account** section.
2. Click **Generate New API Key**.
3. Give the API key a descriptive name (e.g., `Monitoring API Key`).
4. Copy the generated key and store it securely — you'll need it for your monitoring setup.

### Step 3: Copy Your API Key

1. Your new API key will be displayed **only once**.
2. **Important:** Copy the key immediately and store it securely.
3. The format will look something like:

   ```
   sk-140ddce3f0sd480984b4c74b07ed60sd
   ```

> ⚠️ **Security Note:**
> Treat your API key like a password. **Never share it publicly** or commit it to version control systems (e.g., GitHub).

---

## Integrating with Open WebUI

Now that you have your API key, you can configure Open WebUI to connect to Hydra GPT:

### Configuration Parameters

Use the following settings for your integration:

```bash
ENDPOINT=https://gpt.hydra.newpaltz.edu/api/chat/completions
MODEL=gemma3:12b
API_KEY=sk-your-actual-api-key-here
```

### Integration Methods

#### Method 1: Environment Variables

Set these environment variables in your terminal or `.env` file:

```bash
export OPENAI_API_BASE="https://gpt.hydra.newpaltz.edu/api"
export OPENAI_API_KEY="sk-your-actual-api-key-here"
export OPENAI_MODEL="gemma3:12b"
```

#### Method 2: Configuration File

Create or edit your Open WebUI configuration file:

**For Open WebUI (config.json):**

```json
{
  "api": {
    "base_url": "https://gpt.hydra.newpaltz.edu/api/chat/completions",
    "api_key": "sk-your-actual-api-key-here",
    "default_model": "gemma3:12b"
  }
}
```

#### Method 3: cURL Test

Test your connection with a simple cURL command:

```bash
curl https://gpt.hydra.newpaltz.edu/api/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-actual-api-key-here" \
  -d '{
    "model": "gemma3:12b",
    "messages": [
      {
        "role": "user",
        "content": "Hello!"
      }
    ]
  }'
```

---

## Language-Specific Integration Examples

### Python Integration

#### Using OpenAI SDK

```python
import openai
import os

# Configure the OpenAI client to use Hydra GPT
openai.api_base = "https://gpt.hydra.newpaltz.edu/api"
openai.api_key = os.getenv("HYDRA_API_KEY")

# Make a request
response = openai.ChatCompletion.create(
    model="gemma3:12b",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Hello, how are you?"}
    ],
    temperature=0.7,
    max_tokens=500
)

print(response.choices[0].message.content)
```

#### Using Requests Library

```python
import requests
import os
import json

API_KEY = os.getenv("HYDRA_API_KEY")
BASE_URL = "https://gpt.hydra.newpaltz.edu/api"

def chat_with_hydra(message):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }
    
    payload = {
        "model": "gemma3:12b",
        "messages": [
            {"role": "user", "content": message}
        ],
        "temperature": 0.7,
        "max_tokens": 500
    }
    
    response = requests.post(
        f"{BASE_URL}/chat/completions",
        headers=headers,
        json=payload
    )
    
    if response.status_code == 200:
        return response.json()["choices"][0]["message"]["content"]
    else:
        return f"Error: {response.status_code} - {response.text}"

# Example usage
result = chat_with_hydra("Explain machine learning in simple terms.")
print(result)
```

#### Flask Web Application

```python
from flask import Flask, request, jsonify
import openai
import os

app = Flask(__name__)

openai.api_base = "https://gpt.hydra.newpaltz.edu/api"
openai.api_key = os.getenv("HYDRA_API_KEY")

@app.route('/chat', methods=['POST'])
def chat():
    data = request.json
    user_message = data.get('message', '')
    
    try:
        response = openai.ChatCompletion.create(
            model="gemma3:12b",
            messages=[
                {"role": "system", "content": "You are a helpful assistant."},
                {"role": "user", "content": user_message}
            ],
            temperature=0.7,
            max_tokens=500
        )
        
        return jsonify({
            "success": True,
            "response": response.choices[0].message.content
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

if __name__ == '__main__':
    app.run(debug=True, port=5000)
```

---

### JavaScript/Node.js Integration

#### Using Axios

```javascript
const axios = require('axios');

const API_KEY = process.env.HYDRA_API_KEY;
const BASE_URL = 'https://gpt.hydra.newpaltz.edu/api';

async function chatWithHydra(message) {
    try {
        const response = await axios.post(
            `${BASE_URL}/chat/completions`,
            {
                model: 'gemma3:12b',
                messages: [
                    { role: 'user', content: message }
                ],
                temperature: 0.7,
                max_tokens: 500
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                }
            }
        );
        
        return response.data.choices[0].message.content;
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        throw error;
    }
}

// Example usage
chatWithHydra('What is artificial intelligence?')
    .then(response => console.log('AI Response:', response))
    .catch(error => console.error('Failed:', error));
```

#### Using Fetch API (Browser/Node.js 18+)

```javascript
const API_KEY = 'sk-your-actual-api-key-here';
const BASE_URL = 'https://gpt.hydra.newpaltz.edu/api';

async function chatWithHydra(message) {
    const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
            model: 'gemma3:12b',
            messages: [
                { role: 'user', content: message }
            ],
            temperature: 0.7,
            max_tokens: 500
        })
    });
    
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
}

// Example usage
chatWithHydra('Explain quantum computing')
    .then(response => console.log(response))
    .catch(error => console.error('Error:', error));
```

#### Express.js Server

```javascript
const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const API_KEY = process.env.HYDRA_API_KEY;
const BASE_URL = 'https://gpt.hydra.newpaltz.edu/api';

app.post('/api/chat', async (req, res) => {
    const { message } = req.body;
    
    try {
        const response = await axios.post(
            `${BASE_URL}/chat/completions`,
            {
                model: 'gemma3:12b',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.' },
                    { role: 'user', content: message }
                ],
                temperature: 0.7,
                max_tokens: 500
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${API_KEY}`
                }
            }
        );
        
        res.json({
            success: true,
            response: response.data.choices[0].message.content
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

app.listen(3000, () => {
    console.log('Server running on port 3000');
});
```

#### React Frontend Example

```javascript
import React, { useState } from 'react';

function ChatComponent() {
    const [message, setMessage] = useState('');
    const [response, setResponse] = useState('');
    const [loading, setLoading] = useState(false);

    const sendMessage = async () => {
        setLoading(true);
        try {
            const result = await fetch('https://gpt.hydra.newpaltz.edu/api/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${process.env.REACT_APP_HYDRA_API_KEY}`
                },
                body: JSON.stringify({
                    model: 'gemma3:12b',
                    messages: [
                        { role: 'user', content: message }
                    ],
                    temperature: 0.7,
                    max_tokens: 500
                })
            });
            
            const data = await result.json();
            setResponse(data.choices[0].message.content);
        } catch (error) {
            console.error('Error:', error);
            setResponse('Error: ' + error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div>
            <textarea 
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Enter your message"
            />
            <button onClick={sendMessage} disabled={loading}>
                {loading ? 'Sending...' : 'Send'}
            </button>
            {response && (
                <div>
                    <h3>Response:</h3>
                    <p>{response}</p>
                </div>
            )}
        </div>
    );
}

export default ChatComponent;
```

---

### PHP Integration

#### Using cURL

```php
<?php

function chatWithHydra($message) {
    $apiKey = getenv('HYDRA_API_KEY');
    $baseUrl = 'https://gpt.hydra.newpaltz.edu/api';
    
    $data = [
        'model' => 'gemma3:12b',
        'messages' => [
            ['role' => 'user', 'content' => $message]
        ],
        'temperature' => 0.7,
        'max_tokens' => 500
    ];
    
    $ch = curl_init("{$baseUrl}/chat/completions");
    
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            "Authorization: Bearer {$apiKey}"
        ],
        CURLOPT_POSTFIELDS => json_encode($data)
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    
    if (curl_errno($ch)) {
        throw new Exception('cURL Error: ' . curl_error($ch));
    }
    
    curl_close($ch);
    
    if ($httpCode !== 200) {
        throw new Exception("HTTP Error: {$httpCode}");
    }
    
    $result = json_decode($response, true);
    return $result['choices'][0]['message']['content'];
}

// Example usage
try {
    $response = chatWithHydra('What is PHP?');
    echo "AI Response: {$response}\n";
} catch (Exception $e) {
    echo "Error: {$e->getMessage()}\n";
}

?>
```

#### Using Guzzle HTTP Client

```php
<?php

require 'vendor/autoload.php';

use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;

class HydraGPTClient {
    private $client;
    private $apiKey;
    private $baseUrl;
    
    public function __construct($apiKey) {
        $this->apiKey = $apiKey;
        $this->baseUrl = 'https://gpt.hydra.newpaltz.edu/api';
        $this->client = new Client([
            'base_uri' => $this->baseUrl,
            'timeout' => 30.0,
        ]);
    }
    
    public function chat($message, $model = 'gemma3:12b') {
        try {
            $response = $this->client->post('/chat/completions', [
                'headers' => [
                    'Content-Type' => 'application/json',
                    'Authorization' => "Bearer {$this->apiKey}"
                ],
                'json' => [
                    'model' => $model,
                    'messages' => [
                        ['role' => 'user', 'content' => $message]
                    ],
                    'temperature' => 0.7,
                    'max_tokens' => 500
                ]
            ]);
            
            $data = json_decode($response->getBody(), true);
            return $data['choices'][0]['message']['content'];
            
        } catch (GuzzleException $e) {
            throw new Exception("API Error: " . $e->getMessage());
        }
    }
    
    public function listModels() {
        try {
            $response = $this->client->get('/models', [
                'headers' => [
                    'Authorization' => "Bearer {$this->apiKey}"
                ]
            ]);
            
            return json_decode($response->getBody(), true);
            
        } catch (GuzzleException $e) {
            throw new Exception("API Error: " . $e->getMessage());
        }
    }
}

// Example usage
$apiKey = getenv('HYDRA_API_KEY');
$hydra = new HydraGPTClient($apiKey);

try {
    $response = $hydra->chat('Explain object-oriented programming');
    echo "Response: {$response}\n";
    
    // List available models
    $models = $hydra->listModels();
    echo "Available models: " . print_r($models, true);
    
} catch (Exception $e) {
    echo "Error: {$e->getMessage()}\n";
}

?>
```

#### Laravel Integration

```php
<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;
use Exception;

class HydraGPTService
{
    protected $apiKey;
    protected $baseUrl;
    
    public function __construct()
    {
        $this->apiKey = config('services.hydra.api_key');
        $this->baseUrl = config('services.hydra.base_url', 'https://gpt.hydra.newpaltz.edu/api');
    }
    
    public function chat(string $message, array $options = []): string
    {
        $response = Http::withHeaders([
            'Authorization' => "Bearer {$this->apiKey}",
            'Content-Type' => 'application/json',
        ])->post("{$this->baseUrl}/chat/completions", [
            'model' => $options['model'] ?? 'gemma3:12b',
            'messages' => [
                ['role' => 'user', 'content' => $message]
            ],
            'temperature' => $options['temperature'] ?? 0.7,
            'max_tokens' => $options['max_tokens'] ?? 500
        ]);
        
        if (!$response->successful()) {
            throw new Exception("Hydra API Error: " . $response->body());
        }
        
        return $response->json()['choices'][0]['message']['content'];
    }
    
    public function streamChat(string $message, callable $callback): void
    {
        // Streaming implementation
        $response = Http::withHeaders([
            'Authorization' => "Bearer {$this->apiKey}",
            'Content-Type' => 'application/json',
        ])->post("{$this->baseUrl}/chat/completions", [
            'model' => 'gemma3:12b',
            'messages' => [
                ['role' => 'user', 'content' => $message]
            ],
            'stream' => true
        ]);
        
        foreach ($response as $chunk) {
            $callback($chunk);
        }
    }
}

// In your controller
use App\Services\HydraGPTService;

class ChatController extends Controller
{
    protected $hydra;
    
    public function __construct(HydraGPTService $hydra)
    {
        $this->hydra = $hydra;
    }
    
    public function chat(Request $request)
    {
        $validated = $request->validate([
            'message' => 'required|string|max:2000'
        ]);
        
        try {
            $response = $this->hydra->chat($validated['message']);
            
            return response()->json([
                'success' => true,
                'response' => $response
            ]);
        } catch (Exception $e) {
            return response()->json([
                'success' => false,
                'error' => $e->getMessage()
            ], 500);
        }
    }
}
```

---

### Java Integration

#### Using OkHttp

```java
import okhttp3.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.IOException;

public class HydraGPTClient {
    private final String apiKey;
    private final String baseUrl;
    private final OkHttpClient client;
    private final MediaType JSON = MediaType.get("application/json; charset=utf-8");
    
    public HydraGPTClient(String apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = "https://gpt.hydra.newpaltz.edu/api";
        this.client = new OkHttpClient();
    }
    
    public String chat(String message) throws IOException {
        JSONObject jsonBody = new JSONObject();
        jsonBody.put("model", "gemma3:12b");
        jsonBody.put("temperature", 0.7);
        jsonBody.put("max_tokens", 500);
        
        JSONArray messages = new JSONArray();
        JSONObject userMessage = new JSONObject();
        userMessage.put("role", "user");
        userMessage.put("content", message);
        messages.put(userMessage);
        
        jsonBody.put("messages", messages);
        
        RequestBody body = RequestBody.create(jsonBody.toString(), JSON);
        
        Request request = new Request.Builder()
            .url(baseUrl + "/chat/completions")
            .addHeader("Authorization", "Bearer " + apiKey)
            .addHeader("Content-Type", "application/json")
            .post(body)
            .build();
        
        try (Response response = client.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("Unexpected code " + response);
            }
            
            String responseBody = response.body().string();
            JSONObject jsonResponse = new JSONObject(responseBody);
            
            return jsonResponse
                .getJSONArray("choices")
                .getJSONObject(0)
                .getJSONObject("message")
                .getString("content");
        }
    }
    
    public static void main(String[] args) {
        String apiKey = System.getenv("HYDRA_API_KEY");
        HydraGPTClient client = new HydraGPTClient(apiKey);
        
        try {
            String response = client.chat("What is Java programming?");
            System.out.println("AI Response: " + response);
        } catch (IOException e) {
            System.err.println("Error: " + e.getMessage());
            e.printStackTrace();
        }
    }
}
```

#### Using Spring Boot

```java
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class HydraGPTService {
    
    @Value("${hydra.api.key}")
    private String apiKey;
    
    @Value("${hydra.api.base-url:https://gpt.hydra.newpaltz.edu/api}")
    private String baseUrl;
    
    private final RestTemplate restTemplate;
    
    public HydraGPTService(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }
    
    public String chat(String message) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + apiKey);
        headers.set("Content-Type", "application/json");
        
        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("model", "gemma3:12b");
        requestBody.put("temperature", 0.7);
        requestBody.put("max_tokens", 500);
        
        Map<String, String> userMessage = new HashMap<>();
        userMessage.put("role", "user");
        userMessage.put("content", message);
        
        requestBody.put("messages", List.of(userMessage));
        
        HttpEntity<Map<String, Object>> request = new HttpEntity<>(requestBody, headers);
        
        ResponseEntity<Map> response = restTemplate.exchange(
            baseUrl + "/chat/completions",
            HttpMethod.POST,
            request,
            Map.class
        );
        
        Map<String, Object> responseBody = response.getBody();
        List<Map<String, Object>> choices = (List<Map<String, Object>>) responseBody.get("choices");
        Map<String, Object> firstChoice = choices.get(0);
        Map<String, String> messageContent = (Map<String, String>) firstChoice.get("message");
        
        return messageContent.get("content");
    }
}

// Controller
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/chat")
public class ChatController {
    
    private final HydraGPTService hydraGPTService;
    
    public ChatController(HydraGPTService hydraGPTService) {
        this.hydraGPTService = hydraGPTService;
    }
    
    @PostMapping
    public Map<String, Object> chat(@RequestBody Map<String, String> request) {
        try {
            String message = request.get("message");
            String response = hydraGPTService.chat(message);
            
            return Map.of(
                "success", true,
                "response", response
            );
        } catch (Exception e) {
            return Map.of(
                "success", false,
                "error", e.getMessage()
            );
        }
    }
}
```

---

### C# / .NET Integration

#### Using HttpClient

```csharp
using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

public class HydraGPTClient
{
    private readonly HttpClient _httpClient;
    private readonly string _apiKey;
    private readonly string _baseUrl;

    public HydraGPTClient(string apiKey)
    {
        _apiKey = apiKey;
        _baseUrl = "https://gpt.hydra.newpaltz.edu/api";
        _httpClient = new HttpClient();
        _httpClient.DefaultRequestHeaders.Authorization = 
            new AuthenticationHeaderValue("Bearer", apiKey);
    }

    public async Task<string> ChatAsync(string message)
    {
        var requestBody = new
        {
            model = "gemma3:12b",
            messages = new[]
            {
                new { role = "user", content = message }
            },
            temperature = 0.7,
            max_tokens = 500
        };

        var json = JsonSerializer.Serialize(requestBody);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        var response = await _httpClient.PostAsync(
            $"{_baseUrl}/chat/completions", 
            content
        );

        response.EnsureSuccessStatusCode();

        var responseBody = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(responseBody);
        
        return document.RootElement
            .GetProperty("choices")[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString();
    }

    public static async Task Main(string[] args)
    {
        var apiKey = Environment.GetEnvironmentVariable("HYDRA_API_KEY");
        var client = new HydraGPTClient(apiKey);

        try
        {
            var response = await client.ChatAsync("What is C# programming?");
            Console.WriteLine($"AI Response: {response}");
        }
        catch (Exception ex)
        {
            Console.WriteLine($"Error: {ex.Message}");
        }
    }
}
```

#### ASP.NET Core Integration

```csharp
// Service
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

public interface IHydraGPTService
{
    Task<string> ChatAsync(string message);
}

public class HydraGPTService : IHydraGPTService
{
    private readonly HttpClient _httpClient;
    private readonly IConfiguration _configuration;

    public HydraGPTService(HttpClient httpClient, IConfiguration configuration)
    {
        _httpClient = httpClient;
        _configuration = configuration;
        
        var apiKey = _configuration["Hydra:ApiKey"];
        _httpClient.DefaultRequestHeaders.Authorization = 
            new AuthenticationHeaderValue("Bearer", apiKey);
    }

    public async Task<string> ChatAsync(string message)
    {
        var requestBody = new
        {
            model = "gemma3:12b",
            messages = new[]
            {
                new { role = "user", content = message }
            },
            temperature = 0.7,
            max_tokens = 500
        };

        var json = JsonSerializer.Serialize(requestBody);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        var response = await _httpClient.PostAsync("chat/completions", content);
        response.EnsureSuccessStatusCode();

        var responseBody = await response.Content.ReadAsStringAsync();
        using var document = JsonDocument.Parse(responseBody);
        
        return document.RootElement
            .GetProperty("choices")[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString();
    }
}

// Startup configuration
public void ConfigureServices(IServiceCollection services)
{
    services.AddHttpClient<IHydraGPTService, HydraGPTService>(client =>
    {
        client.BaseAddress = new Uri("https://gpt.hydra.newpaltz.edu/api/");
    });
    
    services.AddControllers();
}

// Controller
[ApiController]
[Route("api/[controller]")]
public class ChatController : ControllerBase
{
    private readonly IHydraGPTService _hydraGPTService;

    public ChatController(IHydraGPTService hydraGPTService)
    {
        _hydraGPTService = hydraGPTService;
    }

    [HttpPost]
    public async Task<IActionResult> Chat([FromBody] ChatRequest request)
    {
        try
        {
            var response = await _hydraGPTService.ChatAsync(request.Message);
            return Ok(new { success = true, response });
        }
        catch (Exception ex)
        {
            return StatusCode(500, new { success = false, error = ex.Message });
        }
    }
}

public class ChatRequest
{
    public string Message { get; set; }
}
```

---

### Ruby Integration

```ruby
require 'net/http'
require 'json'
require 'uri'

class HydraGPTClient
  def initialize(api_key)
    @api_key = api_key
    @base_url = 'https://gpt.hydra.newpaltz.edu/api'
  end

  def chat(message, model: 'gemma3:12b', temperature: 0.7, max_tokens: 500)
    uri = URI("#{@base_url}/chat/completions")
    
    request = Net::HTTP::Post.new(uri)
    request['Content-Type'] = 'application/json'
    request['Authorization'] = "Bearer #{@api_key}"
    
    request.body = {
      model: model,
      messages: [
        { role: 'user', content: message }
      ],
      temperature: temperature,
      max_tokens: max_tokens
    }.to_json
    
    response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) do |http|
      http.request(request)
    end
    
    if response.is_a?(Net::HTTPSuccess)
      result = JSON.parse(response.body)
      result['choices'][0]['message']['content']
    else
      raise "API Error: #{response.code} - #{response.body}"
    end
  end

  def list_models
    uri = URI("#{@base_url}/models")
    
    request = Net::HTTP::Get.new(uri)
    request['Authorization'] = "Bearer #{@api_key}"
    
    response = Net::HTTP.start(uri.hostname, uri.port, use_ssl: true) do |http|
      http.request(request)
    end
    
    JSON.parse(response.body) if response.is_a?(Net::HTTPSuccess)
  end
end

# Example usage
api_key = ENV['HYDRA_API_KEY']
client = HydraGPTClient.new(api_key)

begin
  response = client.chat('What is Ruby programming?')
  puts "AI Response: #{response}"
  
  models = client.list_models
  puts "Available models: #{models}"
rescue => e
  puts "Error: #{e.message}"
end
```

---

### Go Integration

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io/ioutil"
    "net/http"
    "os"
)

type HydraGPTClient struct {
    APIKey  string
    BaseURL string
    Client  *http.Client
}

type ChatRequest struct {
    Model       string    `json:"model"`
    Messages    []Message `json:"messages"`
    Temperature float64   `json:"temperature"`
    MaxTokens   int       `json:"max_tokens"`
}

type Message struct {
    Role    string `json:"role"`
    Content string `json:"content"`
}

type ChatResponse struct {
    Choices []struct {
        Message Message `json:"message"`
    } `json:"choices"`
}

func NewHydraGPTClient(apiKey string) *HydraGPTClient {
    return &HydraGPTClient{
        APIKey:  apiKey,
        BaseURL: "https://gpt.hydra.newpaltz.edu/api",
        Client:  &http.Client{},
    }
}

func (c *HydraGPTClient) Chat(message string) (string, error) {
    reqBody := ChatRequest{
        Model: "gemma3:12b",
        Messages: []Message{
            {Role: "user", Content: message},
        },
        Temperature: 0.7,
        MaxTokens:   500,
    }

    jsonData, err := json.Marshal(reqBody)
    if err != nil {
        return "", err
    }

    req, err := http.NewRequest("POST", c.BaseURL+"/chat/completions", bytes.NewBuffer(jsonData))
    if err != nil {
        return "", err
    }

    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("Authorization", "Bearer "+c.APIKey)

    resp, err := c.Client.Do(req)
    if err != nil {
        return "", err
    }
    defer resp.Body.Close()

    if resp.StatusCode != http.StatusOK {
        body, _ := ioutil.ReadAll(resp.Body)
        return "", fmt.Errorf("API error: %d - %s", resp.StatusCode, string(body))
    }

    body, err := ioutil.ReadAll(resp.Body)
    if err != nil {
        return "", err
    }

    var chatResp ChatResponse
    if err := json.Unmarshal(body, &chatResp); err != nil {
        return "", err
    }

    if len(chatResp.Choices) > 0 {
        return chatResp.Choices[0].Message.Content, nil
    }

    return "", fmt.Errorf("no response from API")
}

func main() {
    apiKey := os.Getenv("HYDRA_API_KEY")
    client := NewHydraGPTClient(apiKey)

    response, err := client.Chat("What is Go programming?")
    if err != nil {
        fmt.Printf("Error: %v\n", err)
        return
    }

    fmt.Printf("AI Response: %s\n", response)
}
```

---

### Rust Integration

```rust
use reqwest;
use serde::{Deserialize, Serialize};
use std::env;

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<Message>,
    temperature: f32,
    max_tokens: u32,
}

#[derive(Serialize, Deserialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
}

#[derive(Deserialize)]
struct Choice {
    message: Message,
}

struct HydraGPTClient {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
}

impl HydraGPTClient {
    fn new(api_key: String) -> Self {
        Self {
            api_key,
            base_url: "https://gpt.hydra.newpaltz.edu/api".to_string(),
            client: reqwest::Client::new(),
        }
    }

    async fn chat(&self, message: &str) -> Result<String, Box<dyn std::error::Error>> {
        let request_body = ChatRequest {
            model: "gemma3:12b".to_string(),
            messages: vec![Message {
                role: "user".to_string(),
                content: message.to_string(),
            }],
            temperature: 0.7,
            max_tokens: 500,
        };

        let response = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&request_body)
            .send()
            .await?;

        if !response.status().is_success() {
            return Err(format!("API error: {}", response.status()).into());
        }

        let chat_response: ChatResponse = response.json().await?;

        Ok(chat_response.choices[0].message.content.clone())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = env::var("HYDRA_API_KEY")?;
    let client = HydraGPTClient::new(api_key);

    let response = client.chat("What is Rust programming?").await?;
    println!("AI Response: {}", response);

    Ok(())
}
```

---

## Testing Your Connection

After configuration, verify that everything is working:

### 1. Check API Connectivity

```bash
curl -I https://gpt.hydra.newpaltz.edu/api/models \
  -H "Authorization: Bearer sk-your-actual-api-key-here"
```

You should receive a `200 OK` response.

### 2. List Available Models

```bash
curl https://gpt.hydra.newpaltz.edu/api/models \
  -H "Authorization: Bearer sk-your-actual-api-key-here"
```

This should return a JSON list of available models, including `gemma3:12b`.

### 3. Send a Test Message

Use the cURL example from Method 3 above to send a test message and verify you receive a response.

---

## Troubleshooting

### Common Issues and Solutions

#### 1. 401 Unauthorized Error

- **Cause:** Invalid or expired API key
- **Solution:**
    - Verify your API key is correct
    - Generate a new API key if needed
    - Ensure no extra spaces or characters in the key

#### 2. Model Not Found Error

- **Cause:** Specified model doesn't exist or isn't available
- **Solution:**
    - Use the "List Available Models" command above
    - Verify `gemma3:12b` is in the list
    - Check for typos in the model name

### Getting Help

If you continue to experience issues:

1. **Check Hydra Lab Status:**
    - Visit the Hydra Lab website or contact the admins
2. **Documentation:**
    - Refer to the Open WebUI documentation: https://docs.openwebui.com
    - Check for updates to the integration process

---

## Security Best Practices

1. **Never share your API key** publicly or in code repositories
2. **Use environment variables** for sensitive configuration
3. **Rotate your API keys** regularly
4. **Revoke unused keys** from your account settings
5. **Monitor your usage** for any suspicious activity
6. **Use HTTPS only** for all API communications
7. **Implement rate limiting** in your applications
8. **Validate and sanitize** user inputs before sending to the API

---

## Example Use Cases

### Simple Chat Application (Python)

```python
import os
import openai

# Set up the client
openai.api_base = "https://gpt.hydra.newpaltz.edu/api"
openai.api_key = os.getenv("HYDRA_API_KEY")

def chat(message):
    response = openai.ChatCompletion.create(
        model="gemma3:12b",
        messages=[
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": message}
        ],
        temperature=0.7,
        max_tokens=500
    )
    return response.choices[0].message.content

# Example usage
user_message = "Explain quantum computing in simple terms."
bot_response = chat(user_message)
print(bot_response)
```

### Batch Processing (Python)

```python
import openai
import os

openai.api_base = "https://gpt.hydra.newpaltz.edu/api"
openai.api_key = os.getenv("HYDRA_API_KEY")

questions = [
    "What is machine learning?",
    "Explain neural networks.",
    "What is deep learning?"
]

for question in questions:
    response = openai.ChatCompletion.create(
        model="gemma3:12b",
        messages=[{"role": "user", "content": question}],
        max_tokens=200
    )
    print(f"Q: {question}")
    print(f"A: {response.choices[0].message.content}\n")
```

### Conversational Chatbot (JavaScript)

```javascript
const axios = require('axios');

const API_KEY = process.env.HYDRA_API_KEY;
const BASE_URL = 'https://gpt.hydra.newpaltz.edu/api';

class ChatBot {
    constructor() {
        this.conversationHistory = [];
    }

    async chat(userMessage) {
        // Add user message to history
        this.conversationHistory.push({
            role: 'user',
            content: userMessage
        });

        try {
            const response = await axios.post(
                `${BASE_URL}/chat/completions`,
                {
                    model: 'gemma3:12b',
                    messages: this.conversationHistory,
                    temperature: 0.7,
                    max_tokens: 500
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${API_KEY}`
                    }
                }
            );

            const assistantMessage = response.data.choices[0].message.content;
            
            // Add assistant response to history
            this.conversationHistory.push({
                role: 'assistant',
                content: assistantMessage
            });

            return assistantMessage;
        } catch (error) {
            console.error('Error:', error.response?.data || error.message);
            throw error;
        }
    }

    clearHistory() {
        this.conversationHistory = [];
    }
}

// Example usage
(async () => {
    const bot = new ChatBot();
    
    console.log(await bot.chat('Hello! What can you help me with?'));
    console.log(await bot.chat('Can you explain what AI is?'));
    console.log(await bot.chat('Thanks for the explanation!'));
})();
```

---

## Additional Resources

- **Hydra GPT Platform:** https://gpt.hydra.newpaltz.edu
- **Open WebUI Documentation:** https://docs.openwebui.com

---

## Changelog

- **v1.1** - Added comprehensive language examples (Python, JavaScript, PHP, Java, C#, Ruby, Go, Rust)
- **v1.0** - Initial guide created with Hydra GPT integration instructions
- Endpoint: `https://gpt.hydra.newpaltz.edu/api/chat/completions`
- Default Model: `gemma3:12b`

---

# Hydra Infrastructure Architecture & API Access Guide

## System Overview

```mermaid
graph TB
    subgraph "Internet"
        Student[Student Applications - Python/JS/PHP/Java]
        Browser[Web Browser - Dashboard Access]
    end
    
    subgraph "Hydra Infrastructure - hydra.newpaltz.edu"
        subgraph "Authentication Layer"
            SAML[SAML Auth Service - :6969]
            Azure[Azure AD - Identity Provider]
            JWT[JWT/JWKS - Token Service]
        end
        
        subgraph "Reverse Proxy"
            Traefik[Traefik - Path-based Routing]
        end
        
        subgraph "Core Services"
            Dashboard[Hydra Dashboard - Account Management]
            OpenWebUI[OpenWebUI - :3000/8080 - gpt.hydra.newpaltz.edu]
            Middleman[OpenWebUI Middleman - :7070 - Database API]
        end
        
        subgraph "AI Backend"
            Ollama[Ollama Service - :11434 - Model Management]
            Models[AI Models - Llama/Mistral/etc]
        end
        
        subgraph "Student Containers"
            Jupyter[Jupyter Notebooks]
            VSCode[VS Code Server]
            Static[Static Sites]
            GitProj[GitHub Projects]
        end
        
        subgraph "Storage"
            DB[(SQLite Database - User Accounts)]
            Volumes[(Docker Volumes - Student Data)]
        end
    end
    
    %% Authentication Flow
    Browser -->|HTTPS| Traefik
    Traefik -->|/login| SAML
    SAML <-->|SAML 2.0| Azure
    SAML -->|Issues JWT| JWT
    Browser -->|JWT Cookie| Dashboard
    
    %% API Access Flow
    Student -->|API Key| Traefik
    Traefik -->|/api| OpenWebUI
    OpenWebUI <-->|Model Requests| Ollama
    Ollama <-->|Inference| Models
    
    %% Internal Communications
    Dashboard -->|Manage| Middleman
    Middleman <-->|User CRUD| DB
    OpenWebUI <-->|User Auth| DB
    
    %% Student Container Management
    Dashboard -->|Docker API| Jupyter
    Dashboard -->|Docker API| VSCode
    Dashboard -->|Docker API| Static
    Dashboard -->|Git Clone/Pull| GitProj
    
    %% Storage Connections
    Jupyter -.->|Mount| Volumes
    VSCode -.->|Mount| Volumes
    Static -.->|Mount| Volumes
    GitProj -.->|Mount| Volumes
    
    classDef auth fill:#e1f5fe,stroke:#01579b,stroke-width:2px
    classDef api fill:#f3e5f5,stroke:#4a148c,stroke-width:2px
    classDef storage fill:#fce4ec,stroke:#880e4f,stroke-width:2px
    classDef container fill:#e8f5e9,stroke:#1b5e20,stroke-width:2px
    
    class SAML,Azure,JWT auth
    class OpenWebUI,Ollama,Models api
    class DB,Volumes storage
    class Jupyter,VSCode,Static,GitProj container
```

## Authentication Flow

```mermaid
sequenceDiagram
    participant U as User
    participant B as Browser
    participant T as Traefik
    participant H as Hydra SAML Auth
    participant A as Azure AD
    participant D as Dashboard
    participant O as OpenWebUI

    Note over U,O: Initial Login Flow
    U->>B: Visit hydra.newpaltz.edu
    B->>T: HTTPS Request
    T->>H: Route to Hydra Auth
    H->>B: Redirect to /login
    B->>A: SAML AuthN Request
    A->>U: Show SUNY Login Page
    U->>A: Enter Credentials
    A->>B: SAML Response + Attributes
    B->>H: POST /login/callback
    H->>H: Validate SAML
    H->>H: Generate JWT Token
    H->>B: Set np_access Cookie
    B->>D: Access Dashboard
    
    Note over U,O: API Key Generation
    U->>D: Settings → Account
    D->>D: Generate API Key
    D->>U: Display API Key (one time)
    
    Note over U,O: API Usage
    U->>O: API Request + Bearer Token
    O->>O: Validate API Key
    O->>O: Process Request
    O->>U: JSON Response
```

## Student API Access Pattern

```mermaid
graph LR
    subgraph "Student Development"
        Code[Student Code - API Integration]
        ENV[Environment Variables - OPENWEBUI_API_KEY]
    end
    
    subgraph "API Endpoints"
        Auth["api/auth - Authentication"]
        Chat["api/chat/completions - Chat API"]
        Models["api/models - List Models"]
        Files["api/v1/files - RAG Upload"]
    end
    
    subgraph "Processing"
        OpenWebUI[OpenWebUI - Request Router]
        Ollama[Ollama - Model Engine]
        RAG[RAG Pipeline - Document Processing]
    end
    
    Code -->|Bearer Token| Auth
    Code -->|Bearer Token| Chat
    Code -->|Bearer Token| Models
    Code -->|Bearer Token| Files
    
    Auth --> OpenWebUI
    Chat --> OpenWebUI
    Models --> OpenWebUI
    Files --> OpenWebUI
    
    OpenWebUI --> Ollama
    OpenWebUI --> RAG
    
    style Code fill:#fff2cc
    style ENV fill:#d4edda
```

## Network Architecture

```mermaid
graph TB
    subgraph "External Network"
        Internet[Internet - HTTPS Only]
    end
    
    subgraph "DMZ - Traefik Proxy"
        Traefik[Traefik - :80/:443 - SSL Termination]
    end
    
    subgraph "Internal Networks"
        subgraph "hydra-main-net"
            SAML[SAML Auth - 10.10.0.2]
            OpenWebUI[OpenWebUI - 10.10.0.3]
            Dashboard[Dashboard - 10.10.0.4]
        end
        
        subgraph "hydra-students-net"
            Student1[Student Container 1 - 172.20.0.x]
            Student2[Student Container 2 - 172.20.0.y]
            StudentN[Student Container N - 172.20.0.z]
        end
        
        subgraph "ollama-net"
            Ollama[Ollama Service - 10.11.0.2]
            Models[(Model Storage)]
        end
    end
    
    Internet -->|HTTPS| Traefik
    Traefik -->|Reverse Proxy| SAML
    Traefik -->|Reverse Proxy| OpenWebUI
    Traefik -->|Reverse Proxy| Dashboard
    Traefik -->|Path Routing| Student1
    Traefik -->|Path Routing| Student2
    Traefik -->|Path Routing| StudentN
    
    OpenWebUI <-->|Model API| Ollama
    Dashboard -->|Docker API| Student1
    Dashboard -->|Docker API| Student2
    Dashboard -->|Docker API| StudentN
    
    style Traefik fill:#ffd54f
    style Ollama fill:#81c784
```

## Container Lifecycle Management

```mermaid
stateDiagram-v2
    [*] --> NotExists: Initial State
    
    NotExists --> Creating: User Clicks "Start Container"
    Creating --> Pulling: Pull Docker Image
    Pulling --> Configuring: Set Labels & Network
    Configuring --> Starting: Docker Create & Start
    Starting --> Running: Container Active
    
    Running --> Stopping: User Clicks "Stop"
    Stopping --> Stopped: Container Stopped
    
    Running --> Restarting: User Clicks "Restart"
    Restarting --> Running: Container Restarted
    
    Running --> GitPulling: User Clicks "Pull Latest"
    GitPulling --> Rebuilding: Update Code
    Rebuilding --> Running: Container Updated
    
    Running --> Deleting: User Clicks "Delete"
    Stopped --> Deleting: User Clicks "Delete"
    Deleting --> [*]: Container Removed
    
    Running --> ErrorState: Container Crash
    ErrorState --> Restarting: Auto-restart Policy
    ErrorState --> Stopped: Manual Intervention
```

## API Request Flow

```mermaid
sequenceDiagram
    participant App as Student Application
    participant API as OpenWebUI API
    participant Auth as Auth Service
    participant Model as Ollama/Model
    participant Cache as Response Cache
    
    App->>API: POST /api/chat/completions - Bearer: API_KEY
    API->>Auth: Validate Token
    Auth-->>API: User Context
    
    alt Token Invalid
        API-->>App: 401 Unauthorized
    end
    
    API->>Cache: Check Cache
    alt Response Cached
        Cache-->>API: Cached Response
        API-->>App: 200 OK (from cache)
    else New Request
        API->>Model: Forward Request
        Model->>Model: Process Prompt
        Model-->>API: Generated Response
        API->>Cache: Store Response
        API-->>App: 200 OK (fresh)
    end
```

## Student Container Types

```mermaid
graph TD
    subgraph "Container Presets"
            Jupyter[Jupyter Notebook - Python Data Science]
            Static[Static Website - HTML/CSS/JS]
            Repo[GitHub Repository - Any Language]
    end
    
    subgraph "Jupyter Config"
        J1[Base: jupyter/minimal-notebook]
        J2[Port: 8888]
        J3[Auth: ForwardAuth]
        J4[Volume: /home/jovyan/work]
    end
    
    subgraph "Static Config"
        S1[Base: nginx:alpine]
        S2[Port: 80]
        S3[Auth: None]
        S4[Volume: /usr/share/nginx/html]
    end
    
    subgraph "Repo Config"
        R1[Base: Varies by Runtime]
        R2[Node.js: port 3000]
        R3[Python: port 8000]
        R4[Volume: /workspace]
    end
    
    Jupyter --> J1
    Jupyter --> J2
    Jupyter --> J3
    Jupyter --> J4
    
    Static --> S1
    Static --> S2
    Static --> S3
    Static --> S4
    
    Repo --> R1
    Repo --> R2
    Repo --> R3
    Repo --> R4
```

## OpenWebUI API Structure

```mermaid
graph LR
    subgraph "API Endpoints"
        subgraph "/api - Management"
            M1["api/models"]
            M2["api/chats"]
            M3["api/auth"]
        end
        
        subgraph "/api/v1 - Files"
            F1["api/v1/files"]
            F2["api/v1/knowledge"]
            F3["api/v1/documents"]
        end
        
        subgraph "/v1 - OpenAI Compatible"
            O1["v1/chat/completions"]
            O2["v1/models"]
            O3["v1/embeddings"]
        end
        
        subgraph "/ollama - Direct"
            L1["ollama/api/chat"]
            L2["ollama/api/generate"]
            L3["ollama/api/tags"]
        end
    end
    
    M1 --> Backend[OpenWebUI Backend]
    M2 --> Backend
    M3 --> Backend
    
    F1 --> RAG[RAG Pipeline]
    F2 --> RAG
    F3 --> RAG
    
    O1 --> Adapter[OpenAI Adapter]
    O2 --> Adapter
    O3 --> Adapter
    
    L1 --> Ollama[Ollama Service]
    L2 --> Ollama
    L3 --> Ollama
    
    Backend --> Ollama
    Adapter --> Backend
    RAG --> Backend
```

## Security Architecture

```mermaid
graph TB
    subgraph "Security Layers"
        subgraph "Layer 1: Network"
            FW[Firewall Rules]
            SSL[SSL/TLS Encryption]
            CORS[CORS Policy]
        end
        
        subgraph "Layer 2: Authentication"
            SAML[SAML 2.0]
            JWT[JWT Tokens]
            API[API Keys]
        end
        
        subgraph "Layer 3: Authorization"
            RBAC[Role-Based Access]
            Labels[Container Labels]
            Ownership[Resource Ownership]
        end
        
        subgraph "Layer 4: Runtime"
            Isolation[Container Isolation]
            Limits[Resource Limits]
            Volumes[Volume Permissions]
        end
    end
    
    FW --> SSL
    SSL --> CORS
    CORS --> SAML
    SAML --> JWT
    JWT --> API
    API --> RBAC
    RBAC --> Labels
    Labels --> Ownership
    Ownership --> Isolation
    Isolation --> Limits
    Limits --> Volumes
```

## Data Flow for RAG (Retrieval Augmented Generation)

```mermaid
sequenceDiagram
    participant U as User
    participant A as API
    participant F as File Service
    participant V as Vector DB
    participant E as Embeddings
    participant M as Model
    
    Note over U,M: Document Upload Phase
    U->>A: POST /api/v1/files - Upload PDF/TXT
    A->>F: Store File
    F->>E: Generate Embeddings
    E->>V: Store Vectors
    A-->>U: Return file_id
    
    Note over U,M: Query Phase
    U->>A: POST /api/chat/completions - + file_id
    A->>V: Semantic Search
    V-->>A: Relevant Chunks
    A->>M: Prompt + Context
    M->>M: Generate Response
    M-->>A: Contextual Answer
    A-->>U: JSON Response
```

## Deployment Architecture

```mermaid
graph TB
    subgraph "Development Environment"
        DevCode[Student Code]
        DevAPI[Local OpenWebUI - localhost:3000]
        DevOllama[Local Ollama - localhost:11434]
    end
    
    subgraph "Production - Hydra"
        ProdTraefik[Traefik Proxy - hydra.newpaltz.edu]
        ProdAPI[OpenWebUI - gpt.hydra.newpaltz.edu]
        ProdOllama[Ollama Cluster - GPU Enabled]
        ProdDB[(Production DB)]
    end
    
    subgraph "Models"
        Llama[Llama 3.1]
        Mistral[Mistral]
        CodeLlama[Code Llama]
        Custom[Custom Models]
    end
    
    DevCode -->|Test| DevAPI
    DevAPI <--> DevOllama
    
    DevCode -->|Deploy| ProdTraefik
    ProdTraefik --> ProdAPI
    ProdAPI <--> ProdOllama
    ProdAPI <--> ProdDB
    
    ProdOllama --> Llama
    ProdOllama --> Mistral
    ProdOllama --> CodeLlama
    ProdOllama --> Custom
    
    style DevCode fill:#ffffcc
    style ProdAPI fill:#ccffcc
```

## Troubleshooting Decision Tree

```mermaid
graph TD
    Start[API Not Working?]
    
    Start --> Health{Health Check OK?}
    Health -->|No| CheckService[Check OpenWebUI Service]
    Health -->|Yes| AuthCheck{Auth Working?}
    
    CheckService --> DockerLogs[Check Docker Logs]
    DockerLogs --> ServiceRestart[Restart Service]
    
    AuthCheck -->|No| APIKey{API Key Valid?}
    AuthCheck -->|Yes| ModelCheck{Models Listed?}
    
    APIKey -->|No| GenerateKey[Generate New API Key]
    APIKey -->|Yes| EnableAPI[Enable API in Settings]
    
    ModelCheck -->|No| OllamaCheck{Ollama Running?}
    ModelCheck -->|Yes| RequestCheck{Request Format OK?}
    
    OllamaCheck -->|No| StartOllama[Start/Fix Ollama]
    OllamaCheck -->|Yes| NetworkCheck[Check Network Config]
    
    RequestCheck -->|No| FixFormat[Fix JSON/Headers]
    RequestCheck -->|Yes| CORSCheck{CORS Error?}
    
    CORSCheck -->|Yes| ConfigCORS[Configure CORS]
    CORSCheck -->|No| Success[Working!]
    
    style Start fill:#ffcccc
    style Success fill:#ccffcc
```

## Port Reference

```mermaid
graph LR
    subgraph "Service Ports"
        P1[3000 - OpenWebUI External]
        P2[8080 - OpenWebUI Internal]
        P3[6969 - SAML Auth]
        P4[7070 - Middleman API]
        P5[11434 - Ollama]
        P6[80/443 - Traefik]
        P7[8888 - Jupyter]
        P8[5678 - n8n]
    end
    
    subgraph "Usage"
        U1[Students → 443/HTTPS]
        U2[API Calls → 443/HTTPS]
        U3[Internal → Various]
    end
    
    P1 --> U2
    P2 --> U3
    P3 --> U3
    P4 --> U3
    P5 --> U3
    P6 --> U1
    P6 --> U2
    P7 --> U3
    P8 --> U3
```

## Quick Start Workflow

```mermaid
graph TD
    Start[Student Starts]
    
    Start --> Login[Login via SAML]
    Login --> Dashboard[Access Dashboard]
    Dashboard --> GenKey[Generate API Key]
    GenKey --> TestAPI[Test with curl]
    
    TestAPI --> Success{Working?}
    Success -->|No| Troubleshoot[Check Troubleshooting]
    Success -->|Yes| ChooseLang[Choose Language]
    
    ChooseLang --> Python[Python + OpenAI SDK]
    ChooseLang --> JS[JavaScript + Axios]
    ChooseLang --> PHP[PHP + Guzzle]
    ChooseLang --> Java[Java + OkHttp]
    
    Python --> Build[Build Application]
    JS --> Build
    PHP --> Build
    Java --> Build
    
    Build --> Deploy[Deploy to Container]
    Deploy --> Test[Test in Production]
    
    style Start fill:#e1f5fe
    style Success fill:#c8e6c9
    style Build fill:#fff9c4
```

## Summary

This architecture enables:

1. **Secure Access**: SAML authentication through Azure AD
2. **API Integration**: OpenAI-compatible endpoints for all major languages
3. **Container Management**: Students can run isolated development environments
4. **Model Access**: Direct connection to Ollama-hosted AI models
5. **RAG Capabilities**: Document upload and contextual responses
6. **Scalability**: Traefik routing and Docker orchestration

Students interact with the system by:
1. Authenticating via SAML (automatic with SUNY credentials)
2. Generating an API key through the Dashboard
3. Using that key in their applications to access AI models
4. Optionally deploying their applications as containers on Hydra

The infrastructure handles authentication, routing, model management, and resource allocation transparently, allowing students to focus on building AI-powered applications.
