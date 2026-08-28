float hash11(float p)
{
    p = fract(p * 127.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec3 col = mix(vec3(0.01, 0.04, 0.02), vec3(0.03, 0.09, 0.05), clamp(uv.y + 0.5, 0.0, 1.0));

    for (int i = 0; i < 40; i++)
    {
        float fi = float(i);
        float fx = hash11(fi + 0.123) * 2.2 - 1.1;
        float fy = hash11(fi + 0.456) * 1.4 - 0.55;
        float ax = 0.05 + 0.18 * hash11(fi + 1.1);
        float ay = 0.04 + 0.14 * hash11(fi + 2.2);
        float wx = 0.2 + 0.6 * hash11(fi + 3.3);
        float wy = 0.25 + 0.5 * hash11(fi + 4.4);

        vec2 flyPos = vec2(fx + ax * sin(iTime * wx + fi),
                           fy + ay * sin(iTime * wy + fi * 1.7));
        float pulse = 0.5 + 0.5 * sin(iTime * (1.0 + 2.0 * hash11(fi + 5.5)) + fi);

        float d = length(uv - flyPos);
        float glow = exp(-d * d * 420.0) * pulse;
        float body = 1.0 - smoothstep(0.0, 0.012, d);
        col += vec3(0.55, 1.0, 0.35) * (glow * 0.55 + body * 1.2);
    }

    col *= 1.0 - 0.35 * dot(uv, uv);
    fragColor = vec4(col, 1.0);
}
