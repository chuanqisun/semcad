import { GoogleGenAI } from "@google/genai";
import { createStore, get, set } from "idb-keyval";
import "./style.css";
import type { LoadableTemplate } from "./types";

const asyncTemplates: Record<string, Promise<LoadableTemplate>> = {
  "Tangible Interface v1.0.0": import("./templates/tangible-interface-brainstorm"),
};

class GeminiImageManipulator {
  // --- 1. CONSTANTS ---
  static MODEL = "gemini-2.5-flash-image-preview";
  static TEXT_MODEL = "gemini-2.5-flash";
  static DB_NAME = "semcad-prototype";
  static STORE_NAME = "keyval";
  static PLACEHOLDER_IMAGE = "https://placehold.co/800";

  // --- 2. MAIN CLASS & CONSTRUCTOR ---

  messages: { id: string; text: string; image: { blob: Blob; mimeType: string; dataUrl: string } | null }[] = [];
  nextId: number = 1;
  outputs: { id: string; imageUrl: string | null; text: string; loading: boolean }[] = [];
  nextOutputId: number = 1;
  draggedElement: HTMLElement | null = null;
  draggedId: string | null = null;
  store: any;
  elements: {
    apiKeyInput: HTMLInputElement;
    systemMessage: HTMLTextAreaElement;
    generateImageButton: HTMLButtonElement;
    generateTextButton: HTMLButtonElement;
    messagesContainer: HTMLElement;
    addItemButton: HTMLButtonElement;
    deleteAllButton: HTMLButtonElement;
    outputContainer: HTMLElement;
    deleteAllOutputsButton: HTMLButtonElement;
    templateSelect: HTMLSelectElement;
  };

  constructor() {
    // State: Array of message items
    // Each item: { id: string, text: string, image: {blob, mimeType, dataUrl} | null }
    this.messages = [];
    this.nextId = 1;

    // Output items state
    // Each item: { id: string, imageUrl: string, text: string, loading: boolean }
    this.outputs = [];
    this.nextOutputId = 1;

    // Drag state
    this.draggedElement = null;
    this.draggedId = null;

    // Persistence Store
    this.store = createStore(GeminiImageManipulator.DB_NAME, GeminiImageManipulator.STORE_NAME);

    // DOM Elements
    this.elements = {
      apiKeyInput: document.getElementById("api-key") as HTMLInputElement,
      systemMessage: document.getElementById("system-message") as HTMLTextAreaElement,
      generateImageButton: document.getElementById("generate-button") as HTMLButtonElement,
      generateTextButton: document.getElementById("generate-text-button") as HTMLButtonElement,
      messagesContainer: document.getElementById("messages-container") as HTMLElement,
      addItemButton: document.getElementById("add-item-button") as HTMLButtonElement,
      deleteAllButton: document.getElementById("delete-all-button") as HTMLButtonElement,
      outputContainer: document.getElementById("output-container") as HTMLElement,
      deleteAllOutputsButton: document.getElementById("delete-all-outputs-button") as HTMLButtonElement,
      templateSelect: document.getElementById("template-select") as HTMLSelectElement,
    };

    this.loadState().then(() => {
      this.bindEvents();
      this.renderMessages();
      this.renderOutputs();
      this.populateTemplateSelect();
    });
  }

  // --- Persistence Methods ---

  async loadState() {
    try {
      const { apiKeyInput, systemMessage } = this.elements;

      // Load API Key
      const apiKey = await get("apiKey", this.store);
      if (apiKey) apiKeyInput.value = apiKey;

      // Load System Message
      const systemMsg = await get("systemMessage", this.store);
      if (systemMsg) systemMessage.value = systemMsg;

      // Load Messages
      const messages = await get("messages", this.store);
      if (messages && Array.isArray(messages)) {
        // Reconstruct messages, converting Blobs back to data URLs for images
        this.messages = await Promise.all(
          messages.map(async (msg) => {
            if (msg.image) {
              const dataUrl = await GeminiImageManipulator.blobToDataUrl(msg.image.blob);
              return {
                ...msg,
                image: {
                  ...msg.image,
                  dataUrl: dataUrl,
                },
              };
            }
            return msg;
          })
        );
        // Update nextId to avoid collisions
        const maxId = Math.max(...this.messages.map((m) => parseInt(m.id)), 0);
        this.nextId = maxId + 1;
      }

      // Load Outputs
      const outputs = await get("outputs", this.store);
      if (outputs && Array.isArray(outputs)) {
        this.outputs = outputs.filter((output) => !output.loading); // Remove any loading states
        const maxOutputId = Math.max(...this.outputs.map((o) => parseInt(o.id)), 0);
        this.nextOutputId = maxOutputId + 1;
      }
    } catch (error) {
      console.error("Error loading state from IndexedDB:", error);
    }
  }

  async saveApiKey(key: string) {
    await set("apiKey", key, this.store);
  }

  async saveSystemMessage(message: string) {
    await set("systemMessage", message, this.store);
  }

  async saveMessages() {
    // Store messages, keeping Blobs for images but removing dataUrl
    const serializableMessages = this.messages.map((msg) => {
      if (msg.image) {
        return {
          ...msg,
          image: {
            blob: msg.image.blob,
            mimeType: msg.image.mimeType,
            // dataUrl is omitted for storage efficiency
          },
        };
      }
      return msg;
    });
    await set("messages", serializableMessages, this.store);
  }

  async saveOutputs() {
    // Only save non-loading outputs
    const serializableOutputs = this.outputs.filter((output) => !output.loading);
    await set("outputs", serializableOutputs, this.store);
  }

  // --- Event Binding ---

  bindEvents() {
    this.elements.generateImageButton.addEventListener("click", () => this.handleGenerateImage());
    this.elements.generateTextButton.addEventListener("click", () => this.handleGenerateText());
    this.elements.addItemButton.addEventListener("click", () => this.addItem());
    this.elements.deleteAllButton.addEventListener("click", () => this.deleteAllMessages());
    this.elements.deleteAllOutputsButton.addEventListener("click", () => this.deleteAllOutputs());

    // Persistence listeners
    this.elements.apiKeyInput.addEventListener("input", (e) => this.saveApiKey((e.target as HTMLInputElement).value.trim()));
    this.elements.systemMessage.addEventListener("input", (e) => this.saveSystemMessage((e.target as HTMLTextAreaElement).value.trim()));

    // Template select
    this.elements.templateSelect.addEventListener("change", async (e) => {
      const value = (e.target as HTMLSelectElement).value;
      if (value) {
        await this.loadTemplate(value);
      }
    });
  }

  populateTemplateSelect() {
    this.elements.templateSelect.innerHTML = '<option value="">Select a template...</option>';
    for (const key of Object.keys(asyncTemplates)) {
      const option = document.createElement("option");
      option.value = key;
      option.textContent = key.replace(/([A-Z])/g, " $1").replace(/^./, (str) => str.toUpperCase()); // Capitalize and space
      this.elements.templateSelect.appendChild(option);
    }
  }

  async loadTemplate(templateName: string) {
    try {
      const templateModule = await asyncTemplates[templateName];
      const template = templateModule.template;

      // Clear current messages
      this.messages = [];
      this.nextId = 1;

      // Set system message
      const systemMsg = template.messages.find((m) => m.role === "system");
      if (systemMsg) {
        this.elements.systemMessage.value = systemMsg.text;
        this.saveSystemMessage(systemMsg.text);
      }

      // Add user messages
      for (const msg of template.messages.filter((m) => m.role !== "system")) {
        const id = String(this.nextId++);
        let image = null;
        if (msg.image) {
          // Convert dataUrl to blob
          const response = await fetch(msg.image.dataUrl);
          const blob = await response.blob();
          const mimeType = blob.type;
          const dataUrl = msg.image.dataUrl;
          image = { blob, mimeType, dataUrl };
        }
        this.messages.push({ id, text: msg.text, image });
      }

      this.renderMessages();
      this.saveMessages();
    } catch (error) {
      console.error("Error loading template:", error);
      alert("Failed to load template.");
    }
  }

  // --- Message Management ---

  addItem() {
    const id = String(this.nextId++);
    this.messages.push({
      id,
      text: "",
      image: null,
    });
    this.renderMessages();
    this.saveMessages();
  }

  deleteMessage(id: string) {
    this.messages = this.messages.filter((msg) => msg.id !== id);
    this.renderMessages();
    this.saveMessages();
  }

  deleteAllMessages() {
    this.messages = [];
    this.renderMessages();
    this.saveMessages();
  }

  updateMessageText(id: string, text: string) {
    const message = this.messages.find((msg) => msg.id === id);
    if (message) {
      message.text = text;
      this.saveMessages();
    }
  }

  async updateMessageImage(id: string, file: File) {
    if (!file.type.startsWith("image/")) return;

    const message = this.messages.find((msg) => msg.id === id);
    if (message) {
      const blob = file;
      const mimeType = file.type;
      const dataUrl = await GeminiImageManipulator.blobToDataUrl(blob);

      message.image = {
        blob,
        mimeType,
        dataUrl,
      };

      this.renderMessages();
      this.saveMessages();
    }
  }

  // --- Output Management ---

  addOutput(showImage: boolean = true) {
    const id = String(this.nextOutputId++);
    const output = {
      id,
      imageUrl: showImage ? GeminiImageManipulator.PLACEHOLDER_IMAGE : null,
      text: "Generating...",
      loading: true,
    };
    this.outputs.unshift(output); // Add to top
    this.renderOutputs();
    return id;
  }

  updateOutput(id: string, imageUrl: string | null, text: string) {
    const output = this.outputs.find((o) => o.id === id);
    if (output) {
      output.imageUrl = imageUrl;
      output.text = text;
      output.loading = false;
      this.renderOutputs();
      this.saveOutputs();
    }
  }

  deleteOutput(id: string) {
    this.outputs = this.outputs.filter((o) => o.id !== id);
    this.renderOutputs();
    this.saveOutputs();
  }

  deleteAllOutputs() {
    this.outputs = [];
    this.renderOutputs();
    this.saveOutputs();
  }

  // --- Rendering ---

  renderMessages() {
    const container = this.elements.messagesContainer;
    container.innerHTML = "";

    this.messages.forEach((message) => {
      const itemElement = this.createMessageElement(message);
      container.appendChild(itemElement);
    });
  }

  createMessageElement(message: { id: string; text: string; image: { blob: Blob; mimeType: string; dataUrl: string } | null }) {
    const item = document.createElement("div");
    item.className = "message-item";
    if (message.image) {
      item.classList.add("has-image");
    }
    item.dataset.id = message.id;
    item.draggable = true;

    // Drag Handle
    const dragHandle = document.createElement("div");
    dragHandle.className = "drag-handle";
    dragHandle.innerHTML = "⋮";
    item.appendChild(dragHandle);

    // Thumbnail (only visible when has-image class is present)
    const thumbnail = document.createElement("img");
    thumbnail.className = "message-thumbnail";
    if (message.image) {
      thumbnail.src = message.image.dataUrl;
      thumbnail.alt = "Image";
    }
    item.appendChild(thumbnail);

    // Textarea
    const textarea = document.createElement("textarea");
    textarea.className = "message-textarea";
    textarea.value = message.text;
    textarea.placeholder = "Enter text or paste an image...";
    textarea.addEventListener("input", (e) => {
      this.updateMessageText(message.id, (e.target as HTMLTextAreaElement).value);
    });

    // Handle paste event for images
    textarea.addEventListener("paste", async (e) => {
      const items = e.clipboardData?.items ?? [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
          e.preventDefault();
          const file = items[i].getAsFile();
          if (file) {
            await this.updateMessageImage(message.id, file);
          }
          break; // Only handle first image for now
        }
      }
    });

    item.appendChild(textarea);

    // Buttons Container
    const buttonsContainer = document.createElement("div");
    buttonsContainer.className = "message-buttons";

    // Delete Button
    const deleteButton = document.createElement("button");
    deleteButton.className = "message-button";
    deleteButton.innerHTML = "🗑️";
    deleteButton.title = "Delete";
    deleteButton.addEventListener("click", () => this.deleteMessage(message.id));
    buttonsContainer.appendChild(deleteButton);

    // Upload Image Button
    const uploadButton = document.createElement("button");
    uploadButton.className = "message-button";
    uploadButton.innerHTML = "📷";
    uploadButton.title = "Upload Image";
    uploadButton.addEventListener("click", () => {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.style.display = "none";
      fileInput.addEventListener("change", async (e) => {
        const file = (e.target as HTMLInputElement).files![0];
        if (file) {
          await this.updateMessageImage(message.id, file);
        }
      });
      document.body.appendChild(fileInput);
      fileInput.click();
      document.body.removeChild(fileInput);
    });
    buttonsContainer.appendChild(uploadButton);

    item.appendChild(buttonsContainer);

    // Drag Events
    item.addEventListener("dragstart", (e) => this.handleDragStart(e, message.id));
    item.addEventListener("dragend", (e) => this.handleDragEnd(e));
    item.addEventListener("dragover", (e) => this.handleDragOver(e));
    item.addEventListener("dragleave", (e) => this.handleDragLeave(e));
    item.addEventListener("drop", (e) => this.handleDrop(e, message.id));

    return item;
  }

  renderOutputs() {
    const container = this.elements.outputContainer;
    container.innerHTML = "";

    if (this.outputs.length === 0) {
      container.innerHTML = "<p>No outputs yet</p>";
      return;
    }

    this.outputs.forEach((output) => {
      const itemElement = this.createOutputElement(output);
      container.appendChild(itemElement);
    });
  }

  createOutputElement(output: { id: string; imageUrl: string | null; text: string; loading: boolean }) {
    const item = document.createElement("div");
    item.className = "output-item";
    item.dataset.id = output.id;

    // Content container
    const content = document.createElement("div");
    content.className = "output-item-content";

    // Image (only show if imageUrl is not null)
    if (output.imageUrl) {
      const image = document.createElement("img");
      image.className = "output-item-image";
      if (output.loading) {
        image.classList.add("loading");
      }
      image.src = output.imageUrl;
      image.alt = "Generated Image";
      content.appendChild(image);
    }

    // Text
    const text = document.createElement("div");
    text.className = "output-item-text";
    text.textContent = output.text;
    content.appendChild(text);

    item.appendChild(content);

    // Buttons Container (matching message-buttons style)
    const buttonsContainer = document.createElement("div");
    buttonsContainer.className = "output-item-buttons";

    // Delete button
    const deleteButton = document.createElement("button");
    deleteButton.className = "message-button";
    deleteButton.innerHTML = "🗑️";
    deleteButton.title = "Delete";
    deleteButton.addEventListener("click", () => this.deleteOutput(output.id));
    buttonsContainer.appendChild(deleteButton);

    item.appendChild(buttonsContainer);

    return item;
  }

  // --- Drag and Drop for Reordering ---

  handleDragStart(e: DragEvent, id: string) {
    this.draggedElement = e.currentTarget as HTMLElement;
    this.draggedId = id;
    (e.currentTarget as HTMLElement).classList.add("dragging");
    e.dataTransfer!.effectAllowed = "move";
    e.dataTransfer!.setData("text/html", (e.currentTarget as HTMLElement).innerHTML);
  }

  handleDragEnd(e: DragEvent) {
    (e.currentTarget as HTMLElement).classList.remove("dragging");
    // Remove all drag-over classes
    document.querySelectorAll(".message-item").forEach((item) => {
      item.classList.remove("drag-over-top", "drag-over-bottom");
    });
    this.draggedElement = null;
    this.draggedId = null;
  }

  handleDragOver(e: DragEvent) {
    if (e.preventDefault) {
      e.preventDefault();
    }
    e.dataTransfer!.dropEffect = "move";

    const targetElement = e.currentTarget as HTMLElement;
    if (targetElement === this.draggedElement) {
      return;
    }

    // Determine if we should insert above or below
    const rect = targetElement.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const isTop = e.clientY < midpoint;

    // Remove previous indicators
    targetElement.classList.remove("drag-over-top", "drag-over-bottom");

    // Add appropriate indicator
    if (isTop) {
      targetElement.classList.add("drag-over-top");
    } else {
      targetElement.classList.add("drag-over-bottom");
    }

    return false;
  }

  handleDragLeave(e: Event) {
    (e.currentTarget as HTMLElement).classList.remove("drag-over-top", "drag-over-bottom");
  }

  handleDrop(e: DragEvent, targetId: string) {
    if (e.stopPropagation) {
      e.stopPropagation();
    }
    e.preventDefault();

    const targetElement = e.currentTarget as HTMLElement;
    targetElement.classList.remove("drag-over-top", "drag-over-bottom");

    if (this.draggedId === targetId) {
      return;
    }

    // Determine insertion position
    const rect = targetElement.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    const isTop = e.clientY < midpoint;

    // Reorder messages array
    const draggedIndex = this.messages.findIndex((msg) => msg.id === this.draggedId);
    const targetIndex = this.messages.findIndex((msg) => msg.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    const [draggedMessage] = this.messages.splice(draggedIndex, 1);

    let insertIndex = targetIndex;
    if (draggedIndex < targetIndex) {
      // If dragging down, adjust index
      insertIndex = isTop ? targetIndex - 1 : targetIndex;
    } else {
      // If dragging up
      insertIndex = isTop ? targetIndex : targetIndex + 1;
    }

    this.messages.splice(insertIndex, 0, draggedMessage);

    this.renderMessages();
    this.saveMessages();

    return false;
  }

  // --- 3. CORE LOGIC METHODS ---

  async handleGenerateImage() {
    const { apiKeyInput, systemMessage } = this.elements;
    const apiKey = apiKeyInput.value.trim();
    const systemMsg = systemMessage.value.trim();

    if (!apiKey) {
      alert("Please provide an API Key.");
      return;
    }

    if (!systemMsg && this.messages.length === 0) {
      alert("Please provide either a system message or at least one message item.");
      return;
    }

    // Create output item immediately with placeholder
    const outputId = this.addOutput();

    try {
      const ai = new GoogleGenAI({ apiKey });
      await this.generateImageContent(ai, systemMsg, outputId);
    } catch (error) {
      console.error("Gemini API Error:", error);
      this.updateOutput(outputId, GeminiImageManipulator.PLACEHOLDER_IMAGE, `Error: ${(error as Error).message || "An unknown error occurred."}`);
    }
  }

  async handleGenerateText() {
    const { apiKeyInput, systemMessage } = this.elements;
    const apiKey = apiKeyInput.value.trim();
    const systemMsg = systemMessage.value.trim();

    if (!apiKey) {
      alert("Please provide an API Key.");
      return;
    }

    if (!systemMsg && this.messages.length === 0) {
      alert("Please provide either a system message or at least one message item.");
      return;
    }

    // Create output item without image for text generation
    const outputId = this.addOutput(false);

    try {
      const ai = new GoogleGenAI({ apiKey });
      await this.generateTextContent(ai, systemMsg, outputId);
    } catch (error) {
      console.error("Gemini API Error:", error);
      this.updateOutput(outputId, null, `Error: ${(error as Error).message || "An unknown error occurred."}`);
    }
  }

  /**
   * Calls the Gemini API and handles the streaming response.
   * @param {GoogleGenAI} ai
   * @param {string} systemMsg
   * @param {string} outputId
   */
  async generateImageContent(ai: GoogleGenAI, systemMsg: string, outputId: string) {
    // Build parts array from messages
    const parts = [];

    // Add system message as a user message
    // This appears to be a bug. Image model ignores real system message
    if (systemMsg) {
      parts.push({ text: systemMsg.trim() });
    }

    // Add user messages
    for (const message of this.messages) {
      // Skip empty items (no image and no text)
      if (!message.image && !message.text.trim()) {
        continue;
      }

      // If message has an image, add text first (with "See image:" suffix), then the image
      if (message.image) {
        // Add text if present, or just "See image:"
        const textContent = message.text.trim();
        const textWithPrompt = textContent ? `${textContent}\nSee image:` : "See image:";
        parts.push({ text: textWithPrompt });

        // Then add the image
        const base64Data = await GeminiImageManipulator.blobToBase64(message.image.blob);
        const imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: message.image.mimeType,
          },
        };
        parts.push(imagePart);
      } else {
        // If no image, just add text if present
        if (message.text.trim()) {
          parts.push({ text: message.text.trim() });
        }
      }
    }

    const contents = [
      {
        role: "user",
        parts,
      },
    ];

    const config = {
      responseModalities: ["IMAGE"],
    };

    const response = await ai.models.generateContentStream({
      model: GeminiImageManipulator.MODEL,
      config,
      contents,
    });

    let generatedImageUrls = [];
    let textContent = "";

    for await (const chunk of response) {
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData) {
          const { mimeType: imgMimeType, data } = part.inlineData;
          const imageUrl = `data:${imgMimeType};base64,${data}`;
          generatedImageUrls.push(imageUrl);
        } else if (part.text) {
          textContent += part.text;
        }
      }
    }

    // Update output with results
    if (generatedImageUrls.length > 0) {
      const finalImageUrl = generatedImageUrls[0];
      this.updateOutput(outputId, finalImageUrl, textContent || "Image successfully generated.");
    } else {
      this.updateOutput(outputId, GeminiImageManipulator.PLACEHOLDER_IMAGE, textContent || "Generation complete, but no image was returned.");
    }
  }

  /**
   * Calls the Gemini API for text generation and handles the streaming response.
   * @param {GoogleGenAI} ai
   * @param {string} systemMsg
   * @param {string} outputId
   */
  async generateTextContent(ai: GoogleGenAI, systemMsg: string, outputId: string) {
    // Build parts array from messages
    const parts = [];

    // Add user messages
    for (const message of this.messages) {
      // Skip empty items (no image and no text)
      if (!message.image && !message.text.trim()) {
        continue;
      }

      // If message has an image, add text first (with "See image:" suffix), then the image
      if (message.image) {
        // Add text if present, or just "See image:"
        const textContent = message.text.trim();
        const textWithPrompt = textContent ? `${textContent} See image:` : "See image:";
        parts.push({ text: textWithPrompt });

        // Then add the image
        const base64Data = await GeminiImageManipulator.blobToBase64(message.image.blob);
        const imagePart = {
          inlineData: {
            data: base64Data,
            mimeType: message.image.mimeType,
          },
        };
        parts.push(imagePart);
      } else {
        // If no image, just add text if present
        if (message.text.trim()) {
          parts.push({ text: message.text.trim() });
        }
      }
    }

    const contents = [
      {
        role: "user",
        parts,
      },
    ];

    const config: any = {
      responseModalities: ["TEXT"],
    };

    // Set system instruction in config if present
    if (systemMsg) {
      config.systemInstruction = systemMsg;
    }

    const response = await ai.models.generateContentStream({
      model: GeminiImageManipulator.TEXT_MODEL,
      config,
      contents,
    });

    let textContent = "";

    for await (const chunk of response) {
      const chunkText = chunk.text || "";
      textContent += chunkText;

      // Update output with streaming text (no image)
      this.updateOutput(outputId, null, textContent);
    }

    // Final update to mark as complete
    if (!textContent) {
      textContent = "Text generation complete, but no text was returned.";
    }
    this.updateOutput(outputId, null, textContent);
  }

  // --- 5. UTILITY PURE FUNCTIONS (Static) ---

  /**
   * Converts a Blob object into a base64 string (for API transmission).
   * @param {Blob} blob
   * @returns {Promise<string>} Base64 string without the data URL prefix.
   */
  static blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1];
        resolve(base64);
      };
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(blob);
    });
  }

  /**
   * Converts a Blob object into a data URL (for UI display).
   * @param {Blob} blob
   * @returns {Promise<string>} Data URL string.
   */
  static blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = (error) => reject(error);
      reader.readAsDataURL(blob);
    });
  }
}

// Initialize the application
document.addEventListener("DOMContentLoaded", () => {
  new GeminiImageManipulator();
});
