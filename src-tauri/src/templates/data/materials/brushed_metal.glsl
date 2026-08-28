float hash21(vec2 p)
{
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
}

float noise(vec2 p)
{
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
    vec2 p = uv * 2.6;

    float ang = iTime * 0.12;
    mat2 rotM = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
    vec2 pr = rotM * p;

    float streak = noise(pr * vec2(60.0, 2.2)) * 0.6 + noise(pr * vec2(140.0, 3.4)) * 0.4;
    streak -= 0.5;

    float r = length(p);
    float phi = atan(p.y, p.x);
    vec2 swirl = vec2(sin(r * 5.0 - iTime * 0.35) * 0.22,
                      cos(phi * 2.0 + r * 3.0 - iTime * 0.30) * 0.13);

    vec3 n = normalize(vec3(streak * 0.22 + swirl.x, streak * 0.14 + swirl.y, 1.0));

    vec3 env = vec3(n.x * 1.2, n.y * 1.5 + 0.35, n.z);

    vec3 ldir1 = normalize(vec3(0.6, 0.7, 0.6));
    vec3 ldir2 = normalize(vec3(-0.7, -0.25, 0.5));

    vec3 rf1 = reflect(-ldir1, n);
    vec3 rf2 = reflect(-ldir2, n);

    float spec1 = pow(max(rf1.z, 0.0), 26.0) * (1.0 - min(abs(rf1.x) * 1.6, 1.0));
    float spec2 = pow(max(rf2.z, 0.0), 14.0) * (1.0 - min(abs(rf2.y) * 1.4, 1.0));

    float bandPhase = fract(env.x * 0.5 - iTime * 0.05);
    float band = smoothstep(0.30, 0.0, min(bandPhase, 1.0 - bandPhase) + 0.12);

    float polish = smoothstep(0.85, 1.0, n.z);
    vec3 steel = mix(vec3(0.38, 0.41, 0.47), vec3(0.78, 0.81, 0.88), env.y * 0.5 + 0.5);
    steel = mix(steel, vec3(0.94, 0.95, 0.98), polish * 0.45);

    vec3 col = steel * (0.42 + 0.30 * band);
    col += vec3(1.0, 0.97, 0.90) * spec1 * 0.85;
    col += vec3(0.75, 0.85, 1.0) * spec2 * 0.50;

    col *= 1.0 - 0.25 * dot(uv, uv);

    fragColor = vec4(col, 1.0);
}
