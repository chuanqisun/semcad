export interface Template {
  messages: TemplateMessage[];
}

export interface TemplateMessage {
  role: "system" | "user" | "model";
  text: string;
  image: { dataUrl: string } | null;
}

export interface LoadableTemplate {
  template: Template;
}
