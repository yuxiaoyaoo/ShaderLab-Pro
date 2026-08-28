export const DEFAULT_SHADER = `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = (fragCoord * 2.0 - iResolution.xy) / iResolution.y;

    float t = iTime;
    vec3 col = vec3(0.02, 0.03, 0.06);

    for (float i = 0.0; i < 5.0; i++) {
        float fi = i + 1.0;
        vec2 c = vec2(sin(t * 0.7 + i * 2.1), cos(t * 0.9 + i * 1.3)) * 0.55;
        float d = length(uv - c);
        col += 0.14 / d * vec3(0.3 + 0.7 * sin(fi + t),
                               0.5 + 0.5 * sin(fi * 2.0 + t * 1.3),
                               0.6 + 0.4 * cos(fi * 1.5 + t));
    }

    float r = length(uv);
    col *= smoothstep(1.6, 0.4, r);

    col = pow(col, vec3(0.4545));

    fragColor = vec4(col, 1.0);
}
`;
